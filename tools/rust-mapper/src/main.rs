use proc_macro2::Span;
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use syn::visit::Visit;
use walkdir::WalkDir;

// ── Output schema (matches CodeMapper OutputRoot) ────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputRoot {
    summary: Summary,
    files: Vec<FileNode>,
}

#[derive(Serialize, Default)]
struct Summary {
    files: usize,
    namespaces: usize,
    types: usize,
    methods: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileNode {
    file_path: String,
    members: Vec<CodeMember>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CodeMember {
    #[serde(rename = "type")]
    kind: String,
    signature: String,
    line_number: usize,
    is_static: bool,
    doc_string: String,
    base_types: Vec<String>,
    attributes: Vec<String>,
    children: Vec<CodeMember>,
}

// ── Visitor ───────────────────────────────────────────────────────────────────

struct StructureCollector {
    members: Vec<CodeMember>,
    /// Absolute path of the file being parsed — used for mod resolution
    file_path: PathBuf,
    /// Guard against recursive mod resolution cycles
    visited: HashSet<PathBuf>,
}

impl StructureCollector {
    fn new(file_path: PathBuf, visited: HashSet<PathBuf>) -> Self {
        Self {
            members: Vec::new(),
            file_path,
            visited,
        }
    }
}

// ── Attribute helpers ─────────────────────────────────────────────────────────

fn extract_attrs(attrs: &[syn::Attribute]) -> Vec<String> {
    attrs
        .iter()
        .filter_map(|a| {
            // Keep only outer attributes, skip doc comments handled separately
            if a.path().is_ident("doc") {
                return None;
            }
            // Render the meta tokens as a string, strip leading/trailing #[ ]
            let ts = &a.meta;
            Some(format!("{}", quote::ToTokens::to_token_stream(ts)))
        })
        .collect()
}

fn extract_doc(attrs: &[syn::Attribute]) -> String {
    let mut lines = Vec::new();
    for attr in attrs {
        if attr.path().is_ident("doc") {
            if let syn::Meta::NameValue(nv) = &attr.meta {
                if let syn::Expr::Lit(syn::ExprLit {
                    lit: syn::Lit::Str(s),
                    ..
                }) = &nv.value
                {
                    lines.push(s.value().trim().to_string());
                }
            }
        }
    }
    let joined = lines.join(" ");
    // First sentence only
    joined
        .split('.')
        .next()
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

fn span_line(span: Span) -> usize {
    span.start().line
}

// ── Signature builders ────────────────────────────────────────────────────────

fn fn_signature(f: &syn::ItemFn) -> String {
    let name = &f.sig.ident;
    let inputs: Vec<String> = f
        .sig
        .inputs
        .iter()
        .map(|arg| format!("{}", quote::ToTokens::to_token_stream(arg)))
        .collect();
    let output = match &f.sig.output {
        syn::ReturnType::Default => String::new(),
        syn::ReturnType::Type(_, ty) => {
            format!(" -> {}", quote::ToTokens::to_token_stream(ty))
        }
    };
    format!("fn {}({}){}", name, inputs.join(", "), output)
}

fn method_signature(m: &syn::ImplItemFn) -> (String, bool) {
    let name = &m.sig.ident;
    let inputs: Vec<String> = m
        .sig
        .inputs
        .iter()
        .map(|arg| format!("{}", quote::ToTokens::to_token_stream(arg)))
        .collect();
    let output = match &m.sig.output {
        syn::ReturnType::Default => String::new(),
        syn::ReturnType::Type(_, ty) => {
            format!(" -> {}", quote::ToTokens::to_token_stream(ty))
        }
    };
    let is_static = !m
        .sig
        .inputs
        .iter()
        .any(|arg| matches!(arg, syn::FnArg::Receiver(_)));
    (
        format!("fn {}({}){}", name, inputs.join(", "), output),
        is_static,
    )
}

fn trait_method_signature(m: &syn::TraitItemFn) -> String {
    let name = &m.sig.ident;
    let inputs: Vec<String> = m
        .sig
        .inputs
        .iter()
        .map(|arg| format!("{}", quote::ToTokens::to_token_stream(arg)))
        .collect();
    let output = match &m.sig.output {
        syn::ReturnType::Default => String::new(),
        syn::ReturnType::Type(_, ty) => {
            format!(" -> {}", quote::ToTokens::to_token_stream(ty))
        }
    };
    format!("fn {}({}){}", name, inputs.join(", "), output)
}

fn path_to_string(path: &syn::Path) -> String {
    path.segments
        .iter()
        .map(|s| s.ident.to_string())
        .collect::<Vec<_>>()
        .join("::")
}

// ── mod resolution ────────────────────────────────────────────────────────────

fn resolve_mod_file(current_file: &Path, mod_name: &str) -> Option<PathBuf> {
    let dir = current_file.parent()?;

    // 2018-edition layout: src/foo.rs containing `mod bar;` resolves to src/foo/bar.rs
    // Detect this by checking if the current file is NOT mod.rs / main.rs / lib.rs
    let stem = current_file.file_stem()?.to_string_lossy();
    if stem != "mod" && stem != "main" && stem != "lib" {
        let subdir = dir.join(stem.as_ref());
        let candidate = subdir.join(format!("{}.rs", mod_name));
        if candidate.exists() {
            return Some(candidate);
        }
        let candidate = subdir.join(mod_name).join("mod.rs");
        if candidate.exists() {
            return Some(candidate);
        }
    }

    // Standard layout: sibling foo.rs or foo/mod.rs
    let candidate1 = dir.join(format!("{}.rs", mod_name));
    if candidate1.exists() {
        return Some(candidate1);
    }
    let candidate2 = dir.join(mod_name).join("mod.rs");
    if candidate2.exists() {
        return Some(candidate2);
    }
    None
}

fn parse_file_members(file_path: &Path, visited: &HashSet<PathBuf>) -> Vec<CodeMember> {
    let src = match std::fs::read_to_string(file_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Warning: could not read {}: {}", file_path.display(), e);
            return Vec::new();
        }
    };
    let syntax = match syn::parse_file(&src) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("Warning: parse error in {}: {}", file_path.display(), e);
            return Vec::new();
        }
    };
    let mut collector = StructureCollector::new(file_path.to_path_buf(), visited.clone());
    collector.visit_file(&syntax);
    collector.members
}

// ── Visit impl ────────────────────────────────────────────────────────────────

impl<'ast> Visit<'ast> for StructureCollector {
    fn visit_item_fn(&mut self, node: &'ast syn::ItemFn) {
        let sig = fn_signature(node);
        let member = CodeMember {
            kind: "Fn".into(),
            signature: sig,
            line_number: span_line(node.sig.ident.span()),
            is_static: true,
            doc_string: extract_doc(&node.attrs),
            base_types: Vec::new(),
            attributes: extract_attrs(&node.attrs),
            children: Vec::new(),
        };
        self.members.push(member);
        // Do not recurse into the function body
    }

    fn visit_item_struct(&mut self, node: &'ast syn::ItemStruct) {
        let name = node.ident.to_string();
        let member = CodeMember {
            kind: "Struct".into(),
            signature: format!("struct {}", name),
            line_number: span_line(node.ident.span()),
            is_static: false,
            doc_string: extract_doc(&node.attrs),
            base_types: Vec::new(),
            attributes: extract_attrs(&node.attrs),
            children: Vec::new(),
        };
        self.members.push(member);
    }

    fn visit_item_enum(&mut self, node: &'ast syn::ItemEnum) {
        let name = node.ident.to_string();
        let member = CodeMember {
            kind: "Enum".into(),
            signature: format!("enum {}", name),
            line_number: span_line(node.ident.span()),
            is_static: false,
            doc_string: extract_doc(&node.attrs),
            base_types: Vec::new(),
            attributes: extract_attrs(&node.attrs),
            children: Vec::new(),
        };
        self.members.push(member);
    }

    fn visit_item_trait(&mut self, node: &'ast syn::ItemTrait) {
        let name = node.ident.to_string();
        let base_types: Vec<String> = node
            .supertraits
            .iter()
            .filter_map(|tb| {
                if let syn::TypeParamBound::Trait(t) = tb {
                    Some(path_to_string(&t.path))
                } else {
                    None
                }
            })
            .collect();
        let children: Vec<CodeMember> = node
            .items
            .iter()
            .filter_map(|item| {
                if let syn::TraitItem::Fn(m) = item {
                    let trait_method_is_static = !m
                        .sig
                        .inputs
                        .iter()
                        .any(|arg| matches!(arg, syn::FnArg::Receiver(_)));
                    Some(CodeMember {
                        kind: "Fn".into(),
                        signature: trait_method_signature(m),
                        line_number: span_line(m.sig.ident.span()),
                        is_static: trait_method_is_static,
                        doc_string: extract_doc(&m.attrs),
                        base_types: Vec::new(),
                        attributes: extract_attrs(&m.attrs),
                        children: Vec::new(),
                    })
                } else {
                    None
                }
            })
            .collect();
        let member = CodeMember {
            kind: "Trait".into(),
            signature: format!("trait {}", name),
            line_number: span_line(node.ident.span()),
            is_static: false,
            doc_string: extract_doc(&node.attrs),
            base_types,
            attributes: extract_attrs(&node.attrs),
            children,
        };
        self.members.push(member);
    }

    fn visit_item_impl(&mut self, node: &'ast syn::ItemImpl) {
        let type_name = format!("{}", quote::ToTokens::to_token_stream(&*node.self_ty));
        let (sig, base_types) = if let Some((_, trait_path, _)) = &node.trait_ {
            let trait_name = path_to_string(trait_path);
            (
                format!("impl {} for {}", trait_name, type_name),
                vec![trait_name],
            )
        } else {
            (format!("impl {}", type_name), Vec::new())
        };

        let children: Vec<CodeMember> = node
            .items
            .iter()
            .filter_map(|item| {
                if let syn::ImplItem::Fn(m) = item {
                    let (method_sig, is_static) = method_signature(m);
                    Some(CodeMember {
                        kind: "Fn".into(),
                        signature: method_sig,
                        line_number: span_line(m.sig.ident.span()),
                        is_static,
                        doc_string: extract_doc(&m.attrs),
                        base_types: Vec::new(),
                        attributes: extract_attrs(&m.attrs),
                        children: Vec::new(),
                    })
                } else {
                    None
                }
            })
            .collect();

        let line = node.impl_token.span.start().line;

        let member = CodeMember {
            kind: "Impl".into(),
            signature: sig,
            line_number: line,
            is_static: false,
            doc_string: String::new(),
            base_types,
            attributes: extract_attrs(&node.attrs),
            children,
        };
        self.members.push(member);
    }

    fn visit_item_mod(&mut self, node: &'ast syn::ItemMod) {
        let name = node.ident.to_string();
        let line = span_line(node.ident.span());
        let children = if let Some((_, items)) = &node.content {
            // Inline mod — recurse into items
            let mut sub = StructureCollector::new(self.file_path.clone(), self.visited.clone());
            for item in items {
                sub.visit_item(item);
            }
            sub.members
        } else {
            // External mod — resolve file
            if let Some(resolved) = resolve_mod_file(&self.file_path, &name) {
                let canonical = match resolved.canonicalize() {
                    Ok(c) => c,
                    Err(_) => resolved.clone(),
                };
                if !self.visited.contains(&canonical) {
                    let mut new_visited = self.visited.clone();
                    new_visited.insert(canonical);
                    parse_file_members(&resolved, &new_visited)
                } else {
                    Vec::new()
                }
            } else {
                Vec::new()
            }
        };
        let member = CodeMember {
            kind: "Mod".into(),
            signature: format!("mod {}", name),
            line_number: line,
            is_static: false,
            doc_string: extract_doc(&node.attrs),
            base_types: Vec::new(),
            attributes: extract_attrs(&node.attrs),
            children,
        };
        self.members.push(member);
    }

    fn visit_item_const(&mut self, node: &'ast syn::ItemConst) {
        let name = node.ident.to_string();
        let ty = format!("{}", quote::ToTokens::to_token_stream(&*node.ty));
        let member = CodeMember {
            kind: "Const".into(),
            signature: format!("const {}: {}", name, ty),
            line_number: span_line(node.ident.span()),
            is_static: false,
            doc_string: extract_doc(&node.attrs),
            base_types: Vec::new(),
            attributes: extract_attrs(&node.attrs),
            children: Vec::new(),
        };
        self.members.push(member);
    }

    fn visit_item_static(&mut self, node: &'ast syn::ItemStatic) {
        let name = node.ident.to_string();
        let ty = format!("{}", quote::ToTokens::to_token_stream(&*node.ty));
        let member = CodeMember {
            kind: "Static".into(),
            signature: format!("static {}: {}", name, ty),
            line_number: span_line(node.ident.span()),
            is_static: false,
            doc_string: extract_doc(&node.attrs),
            base_types: Vec::new(),
            attributes: extract_attrs(&node.attrs),
            children: Vec::new(),
        };
        self.members.push(member);
    }
}

// ── Crate detection ───────────────────────────────────────────────────────────

/// Returns the path to the nearest Cargo.toml ancestor of `path`, or None.
fn nearest_cargo_toml(path: &Path, root: &Path) -> Option<PathBuf> {
    let mut dir = if path.is_file() {
        path.parent()?.to_path_buf()
    } else {
        path.to_path_buf()
    };
    loop {
        let candidate = dir.join("Cargo.toml");
        if candidate.exists() {
            return Some(candidate);
        }
        if dir == root {
            break;
        }
        match dir.parent() {
            Some(p) => dir = p.to_path_buf(),
            None => break,
        }
    }
    None
}

static SKIP_DIRS: &[&str] = &["target", ".git", "tests", "examples", "benches"];

fn collect_rs_files(root: &Path) -> Vec<PathBuf> {
    WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| {
            if e.file_type().is_dir() {
                let name = e.file_name().to_string_lossy();
                !SKIP_DIRS.iter().any(|skip| *skip == name.as_ref())
            } else {
                true
            }
        })
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().is_file() && e.path().extension().map(|x| x == "rs").unwrap_or(false)
        })
        .map(|e| e.path().to_path_buf())
        .collect()
}

// ── Entry point ───────────────────────────────────────────────────────────────

fn main() {
    let args: Vec<String> = std::env::args().collect();

    if args.iter().any(|a| a == "--help" || a == "-h") {
        eprintln!("rust-mapper [path] [--format text|json|yaml] [--stdout] [--output <dir>]");
        eprintln!("  Analyze Rust source files and output structure as JSON (CodeMapper schema).");
        std::process::exit(0);
    }

    let mut root_path = PathBuf::from(".");
    let mut use_stdout = false;
    let mut output_dir = PathBuf::from("codebase_ast");
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--stdout" => use_stdout = true,
            "--output" => {
                i += 1;
                if i < args.len() {
                    output_dir = PathBuf::from(&args[i]);
                }
            }
            "--format" => {
                i += 1; // only json supported; flag accepted for CLI compat
            }
            arg if !arg.starts_with('-') => {
                root_path = PathBuf::from(arg);
            }
            _ => {}
        }
        i += 1;
    }

    let root_path = match root_path.canonicalize() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Error: cannot resolve path: {}", e);
            std::process::exit(1);
        }
    };

    // Collect all .rs files
    let rs_files = if root_path.is_file() {
        vec![root_path.clone()]
    } else {
        collect_rs_files(&root_path)
    };

    if rs_files.is_empty() {
        let output = OutputRoot {
            summary: Summary::default(),
            files: Vec::new(),
        };
        match serde_json::to_string_pretty(&output) {
            Ok(json) => println!("{}", json),
            Err(e) => eprintln!("Error: serialize failed: {}", e),
        }
        return;
    }

    // Group by nearest Cargo.toml (crate)
    // If no Cargo.toml found, use root as the group key
    let mut crate_files: std::collections::HashMap<PathBuf, Vec<PathBuf>> =
        std::collections::HashMap::new();
    for f in &rs_files {
        let key = nearest_cargo_toml(f, &root_path).unwrap_or_else(|| root_path.join("Cargo.toml"));
        crate_files.entry(key).or_default().push(f.clone());
    }

    if use_stdout {
        // All files → single JSON blob to stdout
        let file_nodes: Vec<FileNode> = rs_files
            .par_iter()
            .map(|path| {
                let visited = {
                    let mut s = HashSet::new();
                    if let Ok(c) = path.canonicalize() {
                        s.insert(c);
                    }
                    s
                };
                let members = parse_file_members(path, &visited);
                let rel = path
                    .strip_prefix(&root_path)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .to_string();
                FileNode {
                    file_path: rel,
                    members,
                }
            })
            .collect();

        let (namespaces, types, methods) = count_summary(&file_nodes);
        let output = OutputRoot {
            summary: Summary {
                files: file_nodes.len(),
                namespaces,
                types,
                methods,
            },
            files: file_nodes,
        };
        match serde_json::to_string_pretty(&output) {
            Ok(json) => println!("{}", json),
            Err(e) => eprintln!("Error: serialize failed: {}", e),
        }
    } else {
        // Write one file per crate
        std::fs::create_dir_all(&output_dir).unwrap_or_else(|e| {
            eprintln!("Warning: could not create output dir: {}", e);
        });

        for (cargo_toml, files) in &crate_files {
            let crate_name = cargo_toml
                .parent()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "unknown".to_string());

            let file_nodes: Vec<FileNode> = files
                .par_iter()
                .map(|path| {
                    let visited = {
                        let mut s = HashSet::new();
                        if let Ok(c) = path.canonicalize() {
                            s.insert(c);
                        }
                        s
                    };
                    let members = parse_file_members(path, &visited);
                    let rel = path
                        .strip_prefix(&root_path)
                        .unwrap_or(path)
                        .to_string_lossy()
                        .to_string();
                    FileNode {
                        file_path: rel,
                        members,
                    }
                })
                .collect();

            let (namespaces, types, methods) = count_summary(&file_nodes);
            let output = OutputRoot {
                summary: Summary {
                    files: file_nodes.len(),
                    namespaces,
                    types,
                    methods,
                },
                files: file_nodes,
            };

            let out_file = output_dir.join(format!("{}.json", crate_name));
            match serde_json::to_string_pretty(&output) {
                Ok(json) => {
                    if let Err(e) = std::fs::write(&out_file, &json) {
                        eprintln!("Warning: could not write {}: {}", out_file.display(), e);
                    } else {
                        eprintln!("Wrote {}", out_file.display());
                    }
                }
                Err(e) => eprintln!("Warning: serialize error for {}: {}", crate_name, e),
            }
        }
    }
}

fn count_summary(files: &[FileNode]) -> (usize, usize, usize) {
    let mut namespaces = 0usize;
    let mut types = 0usize;
    let mut methods = 0usize;
    for f in files {
        count_members(&f.members, &mut namespaces, &mut types, &mut methods);
    }
    (namespaces, types, methods)
}

fn count_members(
    members: &[CodeMember],
    namespaces: &mut usize,
    types: &mut usize,
    methods: &mut usize,
) {
    for m in members {
        match m.kind.as_str() {
            "Mod" => *namespaces += 1,
            "Struct" | "Enum" | "Trait" => *types += 1,
            "Fn" => *methods += 1,
            _ => {}
        }
        count_members(&m.children, namespaces, types, methods);
    }
}
