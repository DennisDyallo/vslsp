use proc_macro2::Span;
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use syn::visit::Visit;
use walkdir::WalkDir;

// ── Output schema (matches CSharpMapper OutputRoot) ──────────────────────────

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
    visibility: String,
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
            if a.path().is_ident("doc") {
                return None;
            }
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
    joined
        .split('.')
        .next()
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

fn span_line(span: Span) -> usize {
    span.start().line
}

// ── A1: Type rendering (clean, no token-stream spacing artifacts) ─────────────

fn type_to_string(ty: &syn::Type) -> String {
    match ty {
        syn::Type::Reference(r) => {
            let lt = r
                .lifetime
                .as_ref()
                .map(|l| format!("'{} ", l.ident))
                .unwrap_or_default();
            let mut_ = if r.mutability.is_some() { "mut " } else { "" };
            format!("&{}{}{}", lt, mut_, type_to_string(&r.elem))
        }
        syn::Type::Path(p) => path_type_to_string(&p.path),
        syn::Type::Slice(s) => format!("[{}]", type_to_string(&s.elem)),
        syn::Type::Array(a) => format!(
            "[{}; {}]",
            type_to_string(&a.elem),
            quote::ToTokens::to_token_stream(&a.len) // const exprs are fine with token stream
        ),
        syn::Type::Tuple(t) => {
            let elems: Vec<_> = t.elems.iter().map(type_to_string).collect();
            format!("({})", elems.join(", "))
        }
        syn::Type::Ptr(p) => {
            let mut_ = if p.mutability.is_some() {
                "mut "
            } else {
                "const "
            };
            format!("*{}{}", mut_, type_to_string(&p.elem))
        }
        syn::Type::TraitObject(t) => {
            let bounds: Vec<_> = t.bounds.iter().map(bound_to_string).collect();
            format!("dyn {}", bounds.join(" + "))
        }
        syn::Type::ImplTrait(t) => {
            let bounds: Vec<_> = t.bounds.iter().map(bound_to_string).collect();
            format!("impl {}", bounds.join(" + "))
        }
        syn::Type::Paren(p) => type_to_string(&p.elem),
        // Fallback: BareFn, Infer, Macro, Never, Verbatim
        _ => format!("{}", quote::ToTokens::to_token_stream(ty)),
    }
}

fn path_type_to_string(path: &syn::Path) -> String {
    path.segments
        .iter()
        .map(|seg| {
            let args = match &seg.arguments {
                syn::PathArguments::None => String::new(),
                syn::PathArguments::AngleBracketed(ab) => {
                    let args: Vec<_> = ab.args.iter().map(generic_arg_to_string).collect();
                    format!("<{}>", args.join(", "))
                }
                syn::PathArguments::Parenthesized(p) => {
                    let inputs: Vec<_> = p.inputs.iter().map(type_to_string).collect();
                    let output = match &p.output {
                        syn::ReturnType::Default => String::new(),
                        syn::ReturnType::Type(_, ty) => format!(" -> {}", type_to_string(ty)),
                    };
                    format!("({}){}", inputs.join(", "), output)
                }
            };
            format!("{}{}", seg.ident, args)
        })
        .collect::<Vec<_>>()
        .join("::")
}

fn generic_arg_to_string(arg: &syn::GenericArgument) -> String {
    match arg {
        syn::GenericArgument::Type(ty) => type_to_string(ty),
        syn::GenericArgument::Lifetime(lt) => format!("'{}", lt.ident),
        syn::GenericArgument::Const(expr) => {
            format!("{}", quote::ToTokens::to_token_stream(expr))
        }
        syn::GenericArgument::AssocType(at) => {
            format!("{} = {}", at.ident, type_to_string(&at.ty))
        }
        _ => format!("{}", quote::ToTokens::to_token_stream(arg)),
    }
}

fn bound_to_string(bound: &syn::TypeParamBound) -> String {
    match bound {
        syn::TypeParamBound::Trait(t) => path_type_to_string(&t.path),
        syn::TypeParamBound::Lifetime(lt) => format!("'{}", lt.ident),
        _ => format!("{}", quote::ToTokens::to_token_stream(bound)),
    }
}

fn fn_arg_to_string(arg: &syn::FnArg) -> String {
    match arg {
        syn::FnArg::Receiver(r) => {
            let ref_part = if let Some((_, lt)) = &r.reference {
                let lt_str = lt
                    .as_ref()
                    .map(|l| format!("'{} ", l.ident))
                    .unwrap_or_default();
                format!("&{}", lt_str)
            } else {
                String::new()
            };
            let mut_ = if r.mutability.is_some() { "mut " } else { "" };
            format!("{}{}self", ref_part, mut_)
        }
        syn::FnArg::Typed(pt) => {
            // Pattern names (identifiers) are fine to render via token stream
            let pat = format!("{}", quote::ToTokens::to_token_stream(&*pt.pat));
            format!("{}: {}", pat, type_to_string(&pt.ty))
        }
    }
}

// ── A2: Function modifiers and generic bounds ─────────────────────────────────

fn sig_modifiers(sig: &syn::Signature) -> String {
    let mut parts = Vec::new();
    if sig.constness.is_some() {
        parts.push("const");
    }
    if sig.asyncness.is_some() {
        parts.push("async");
    }
    if sig.unsafety.is_some() {
        parts.push("unsafe");
    }
    parts.join(" ")
}

fn generics_to_string(generics: &syn::Generics) -> String {
    if generics.params.is_empty() {
        return String::new();
    }
    let params: Vec<_> = generics
        .params
        .iter()
        .map(|p| match p {
            syn::GenericParam::Type(t) => {
                if t.bounds.is_empty() {
                    t.ident.to_string()
                } else {
                    let bounds: Vec<_> = t.bounds.iter().map(bound_to_string).collect();
                    format!("{}: {}", t.ident, bounds.join(" + "))
                }
            }
            syn::GenericParam::Lifetime(l) => format!("'{}", l.lifetime.ident),
            syn::GenericParam::Const(c) => {
                format!("const {}: {}", c.ident, type_to_string(&c.ty))
            }
        })
        .collect();
    format!("<{}>", params.join(", "))
}

// ── A3: Visibility ────────────────────────────────────────────────────────────

fn visibility_to_string(vis: &syn::Visibility) -> String {
    match vis {
        syn::Visibility::Public(_) => "public".into(),
        syn::Visibility::Restricted(r) => match path_to_string(&r.path).as_str() {
            "crate" => "crate".into(),
            "super" => "super".into(),
            "self" => "private".into(),
            other => format!("restricted({})", other),
        },
        syn::Visibility::Inherited => "private".into(),
    }
}

/// Returns the `pub`/`pub(crate)` prefix to prepend to a signature string,
/// so signatures match source code verbatim.
fn vis_prefix_str(vis: &syn::Visibility) -> &'static str {
    match vis {
        syn::Visibility::Public(_) => "pub ",
        syn::Visibility::Restricted(_) => "pub(...) ",
        syn::Visibility::Inherited => "",
    }
}

// ── Signature builders ────────────────────────────────────────────────────────

/// Path rendered as segment names only (no generics) — for trait/impl names.
fn path_to_string(path: &syn::Path) -> String {
    path.segments
        .iter()
        .map(|s| s.ident.to_string())
        .collect::<Vec<_>>()
        .join("::")
}

fn fn_signature(f: &syn::ItemFn) -> String {
    let name = &f.sig.ident;
    let inputs: Vec<String> = f.sig.inputs.iter().map(fn_arg_to_string).collect();
    let output = match &f.sig.output {
        syn::ReturnType::Default => String::new(),
        syn::ReturnType::Type(_, ty) => format!(" -> {}", type_to_string(ty)),
    };
    let mods = sig_modifiers(&f.sig);
    let mod_prefix = if mods.is_empty() {
        String::new()
    } else {
        format!("{} ", mods)
    };
    let vis = vis_prefix_str(&f.vis);
    format!(
        "{}{}fn {}{}({}){}",
        vis,
        mod_prefix,
        name,
        generics_to_string(&f.sig.generics),
        inputs.join(", "),
        output
    )
}

fn method_signature(m: &syn::ImplItemFn) -> (String, bool) {
    let name = &m.sig.ident;
    let inputs: Vec<String> = m.sig.inputs.iter().map(fn_arg_to_string).collect();
    let output = match &m.sig.output {
        syn::ReturnType::Default => String::new(),
        syn::ReturnType::Type(_, ty) => format!(" -> {}", type_to_string(ty)),
    };
    let is_static = !m
        .sig
        .inputs
        .iter()
        .any(|arg| matches!(arg, syn::FnArg::Receiver(_)));
    let mods = sig_modifiers(&m.sig);
    let mod_prefix = if mods.is_empty() {
        String::new()
    } else {
        format!("{} ", mods)
    };
    let vis = vis_prefix_str(&m.vis);
    (
        format!(
            "{}{}fn {}{}({}){}",
            vis,
            mod_prefix,
            name,
            generics_to_string(&m.sig.generics),
            inputs.join(", "),
            output
        ),
        is_static,
    )
}

fn trait_method_signature(m: &syn::TraitItemFn) -> String {
    let name = &m.sig.ident;
    let inputs: Vec<String> = m.sig.inputs.iter().map(fn_arg_to_string).collect();
    let output = match &m.sig.output {
        syn::ReturnType::Default => String::new(),
        syn::ReturnType::Type(_, ty) => format!(" -> {}", type_to_string(ty)),
    };
    let mods = sig_modifiers(&m.sig);
    let mod_prefix = if mods.is_empty() {
        String::new()
    } else {
        format!("{} ", mods)
    };
    // Trait methods are always public by language rules — no vis prefix in source
    format!(
        "{}fn {}{}({}){}",
        mod_prefix,
        name,
        generics_to_string(&m.sig.generics),
        inputs.join(", "),
        output
    )
}

// ── A4: Struct fields and enum variants ──────────────────────────────────────

fn field_to_member(field: &syn::Field, idx: usize) -> CodeMember {
    let name = field
        .ident
        .as_ref()
        .map(|i| i.to_string())
        .unwrap_or_else(|| idx.to_string()); // tuple structs: "0", "1", ...
    let ty = type_to_string(&field.ty);
    let vis = visibility_to_string(&field.vis);
    let vis_prefix = vis_prefix_str(&field.vis);
    CodeMember {
        kind: "Field".into(),
        signature: format!("{}{}: {}", vis_prefix, name, ty),
        line_number: field
            .ident
            .as_ref()
            .map(|i| span_line(i.span()))
            .unwrap_or(0),
        is_static: false,
        visibility: vis,
        doc_string: extract_doc(&field.attrs),
        base_types: Vec::new(),
        attributes: extract_attrs(&field.attrs),
        children: Vec::new(),
    }
}

fn variant_to_member(variant: &syn::Variant) -> CodeMember {
    let name = variant.ident.to_string();
    let sig = match &variant.fields {
        syn::Fields::Unit => name.clone(),
        syn::Fields::Unnamed(f) => {
            let types: Vec<_> = f.unnamed.iter().map(|f| type_to_string(&f.ty)).collect();
            format!("{}({})", name, types.join(", "))
        }
        syn::Fields::Named(f) => {
            let parts: Vec<_> = f
                .named
                .iter()
                .map(|f| {
                    let n = f.ident.as_ref().map(|i| i.to_string()).unwrap_or_default();
                    format!("{}: {}", n, type_to_string(&f.ty))
                })
                .collect();
            format!("{} {{ {} }}", name, parts.join(", "))
        }
    };
    CodeMember {
        kind: "Variant".into(),
        signature: sig,
        line_number: span_line(variant.ident.span()),
        is_static: false,
        visibility: "public".into(), // enum variants are always public
        doc_string: extract_doc(&variant.attrs),
        base_types: Vec::new(),
        attributes: extract_attrs(&variant.attrs),
        children: Vec::new(),
    }
}

// ── mod resolution ────────────────────────────────────────────────────────────

fn resolve_mod_file(current_file: &Path, mod_name: &str) -> Option<PathBuf> {
    let dir = current_file.parent()?;

    // 2018-edition layout: src/foo.rs containing `mod bar;` resolves to src/foo/bar.rs
    // Only applies when the current file is NOT mod.rs / main.rs / lib.rs
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
        let member = CodeMember {
            kind: "Fn".into(),
            signature: fn_signature(node),
            line_number: span_line(node.sig.ident.span()),
            is_static: true,
            visibility: visibility_to_string(&node.vis),
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
        let vis = visibility_to_string(&node.vis);
        let vis_pre = vis_prefix_str(&node.vis);
        let children: Vec<CodeMember> = match &node.fields {
            syn::Fields::Named(f) => f
                .named
                .iter()
                .enumerate()
                .map(|(i, f)| field_to_member(f, i))
                .collect(),
            syn::Fields::Unnamed(f) => f
                .unnamed
                .iter()
                .enumerate()
                .map(|(i, f)| field_to_member(f, i))
                .collect(),
            syn::Fields::Unit => Vec::new(),
        };
        let member = CodeMember {
            kind: "Struct".into(),
            signature: format!("{}struct {}", vis_pre, name),
            line_number: span_line(node.ident.span()),
            is_static: false,
            visibility: vis,
            doc_string: extract_doc(&node.attrs),
            base_types: Vec::new(),
            attributes: extract_attrs(&node.attrs),
            children,
        };
        self.members.push(member);
    }

    fn visit_item_enum(&mut self, node: &'ast syn::ItemEnum) {
        let name = node.ident.to_string();
        let vis = visibility_to_string(&node.vis);
        let vis_pre = vis_prefix_str(&node.vis);
        let children: Vec<CodeMember> = node.variants.iter().map(variant_to_member).collect();
        let member = CodeMember {
            kind: "Enum".into(),
            signature: format!("{}enum {}", vis_pre, name),
            line_number: span_line(node.ident.span()),
            is_static: false,
            visibility: vis,
            doc_string: extract_doc(&node.attrs),
            base_types: Vec::new(),
            attributes: extract_attrs(&node.attrs),
            children,
        };
        self.members.push(member);
    }

    fn visit_item_trait(&mut self, node: &'ast syn::ItemTrait) {
        let name = node.ident.to_string();
        let vis = visibility_to_string(&node.vis);
        let vis_pre = vis_prefix_str(&node.vis);
        let base_types: Vec<String> = node
            .supertraits
            .iter()
            .filter_map(|tb| {
                if let syn::TypeParamBound::Trait(t) = tb {
                    Some(path_type_to_string(&t.path))
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
                    let is_static = !m
                        .sig
                        .inputs
                        .iter()
                        .any(|arg| matches!(arg, syn::FnArg::Receiver(_)));
                    Some(CodeMember {
                        kind: "Fn".into(),
                        signature: trait_method_signature(m),
                        line_number: span_line(m.sig.ident.span()),
                        is_static,
                        visibility: "public".into(), // trait items are always public
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
            signature: format!(
                "{}trait {}{}",
                vis_pre,
                name,
                generics_to_string(&node.generics)
            ),
            line_number: span_line(node.ident.span()),
            is_static: false,
            visibility: vis,
            doc_string: extract_doc(&node.attrs),
            base_types,
            attributes: extract_attrs(&node.attrs),
            children,
        };
        self.members.push(member);
    }

    fn visit_item_impl(&mut self, node: &'ast syn::ItemImpl) {
        let type_name = type_to_string(&node.self_ty);
        let (sig, base_types) = if let Some((_, trait_path, _)) = &node.trait_ {
            let trait_name = path_type_to_string(trait_path);
            (
                format!("impl {} for {}", trait_name, type_name),
                vec![trait_name],
            )
        } else {
            (
                format!("impl {}{}", generics_to_string(&node.generics), type_name),
                Vec::new(),
            )
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
                        visibility: visibility_to_string(&m.vis),
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
            visibility: "private".into(), // impl blocks have no visibility
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
        let vis = visibility_to_string(&node.vis);
        let vis_pre = vis_prefix_str(&node.vis);
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
            signature: format!("{}mod {}", vis_pre, name),
            line_number: line,
            is_static: false,
            visibility: vis,
            doc_string: extract_doc(&node.attrs),
            base_types: Vec::new(),
            attributes: extract_attrs(&node.attrs),
            children,
        };
        self.members.push(member);
    }

    fn visit_item_const(&mut self, node: &'ast syn::ItemConst) {
        let name = node.ident.to_string();
        let ty = type_to_string(&node.ty);
        let vis = visibility_to_string(&node.vis);
        let vis_pre = vis_prefix_str(&node.vis);
        let member = CodeMember {
            kind: "Const".into(),
            signature: format!("{}const {}: {}", vis_pre, name, ty),
            line_number: span_line(node.ident.span()),
            is_static: false,
            visibility: vis,
            doc_string: extract_doc(&node.attrs),
            base_types: Vec::new(),
            attributes: extract_attrs(&node.attrs),
            children: Vec::new(),
        };
        self.members.push(member);
    }

    fn visit_item_static(&mut self, node: &'ast syn::ItemStatic) {
        let name = node.ident.to_string();
        let ty = type_to_string(&node.ty);
        let vis = visibility_to_string(&node.vis);
        let vis_pre = vis_prefix_str(&node.vis);
        let member = CodeMember {
            kind: "Static".into(),
            signature: format!("{}static {}: {}", vis_pre, name, ty),
            line_number: span_line(node.ident.span()),
            is_static: false,
            visibility: vis,
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
        eprintln!(
            "  Analyze Rust source files and output structure as JSON (CSharpMapper schema)."
        );
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

    // Group by nearest Cargo.toml (crate); fall back to synthetic root key
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
