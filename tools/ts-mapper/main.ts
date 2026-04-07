import ts from "typescript";
import { statSync, readFileSync, readdirSync } from "fs";
import { join, resolve, relative, extname, dirname, basename } from "path";

// ── Output schema (matches CSharpMapper/RustMapper) ──────────────────────────

interface CodeMember {
  type: string;
  signature: string;
  lineNumber: number;
  isStatic: boolean;
  visibility: string;
  docString: string;
  baseTypes: string[];
  attributes: string[];
  children: CodeMember[];
}

interface FileNode {
  filePath: string;
  members: CodeMember[];
}

interface OutputRoot {
  summary: { files: number; namespaces: number; types: number; methods: number };
  files: FileNode[];
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.error("ts-mapper [path] [--format text|json|yaml] [--stdout] [--output <dir>]");
  console.error("  Analyze TypeScript source files and output structure (CSharpMapper schema).");
  process.exit(0);
}

let rootPath = ".";
let format = "json";
let outputDir = "codebase_ast";
let stdoutMode = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if ((arg === "--format" || arg === "-f") && i + 1 < args.length) {
    format = args[++i]!.toLowerCase();
    if (!["text", "json", "yaml"].includes(format)) {
      console.error("Invalid format. Use: text, json, or yaml");
      process.exit(1);
    }
  } else if (arg === "--output" && i + 1 < args.length) {
    outputDir = args[++i]!;
    stdoutMode = false;
  } else if (arg === "--stdout") {
    stdoutMode = true;
  } else if (arg && !arg.startsWith("-")) {
    rootPath = arg;
  }
}

rootPath = resolve(rootPath);

// ── File collection ─────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", ".git", ".next", ".nuxt",
  "coverage", ".turbo", ".cache", "__pycache__",
]);

function collectFiles(dir: string): string[] {
  const stat = statSync(dir);
  if (stat.isFile()) {
    const ext = extname(dir);
    if (ext === ".ts" || ext === ".tsx") return [dir];
    return [];
  }

  const results: string[] = [];
  function walk(d: string) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(d, entry.name));
      } else if (entry.isFile()) {
        const ext = extname(entry.name);
        if ((ext === ".ts" || ext === ".tsx") && !entry.name.endsWith(".d.ts")) {
          results.push(join(d, entry.name));
        }
      }
    }
  }
  walk(dir);
  return results;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getLineNumber(node: ts.Node, sf: ts.SourceFile): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node);
  return mods?.some(m => m.kind === kind) ?? false;
}

function extractVisibility(node: ts.Node): string {
  if (!ts.canHaveModifiers(node)) return "public";
  const mods = ts.getModifiers(node);
  if (!mods) return "public";
  for (const m of mods) {
    if (m.kind === ts.SyntaxKind.PrivateKeyword) return "private";
    if (m.kind === ts.SyntaxKind.ProtectedKeyword) return "protected";
  }
  return "public";
}

function isExported(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function isNodeStatic(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.StaticKeyword);
}

function extractDocString(node: ts.Node, sourceText: string): string {
  const jsDocs = (node as any).jsDoc as ts.JSDoc[] | undefined;
  if (jsDocs && jsDocs.length > 0) {
    const doc = jsDocs[0]!;
    const comment = doc.comment;
    if (!comment) return "";
    const text = typeof comment === "string"
      ? comment
      : (comment as ts.NodeArray<ts.JSDocComment>)
          .map((c: any) => c.text ?? "")
          .join("");
    return firstSentence(text);
  }

  // Fallback: leading comment ranges
  const ranges = ts.getLeadingCommentRanges(sourceText, node.getFullStart());
  if (!ranges) return "";
  for (const r of ranges) {
    const raw = sourceText.slice(r.pos, r.end);
    if (raw.startsWith("/**")) {
      const cleaned = raw
        .replace(/^\/\*\*/, "")
        .replace(/\*\/$/, "")
        .replace(/^\s*\*\s?/gm, "")
        .trim();
      return firstSentence(cleaned);
    }
  }
  return "";
}

function firstSentence(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const period = cleaned.indexOf(".");
  if (period > 0 && period < 120) return cleaned.slice(0, period + 1);
  if (cleaned.length > 120) return cleaned.slice(0, 120) + "...";
  return cleaned;
}

function extractDecorators(node: ts.Node, sf: ts.SourceFile): string[] {
  if (!ts.canHaveDecorators(node)) return [];
  const decorators = ts.getDecorators(node);
  if (!decorators) return [];
  return decorators.map(d => d.expression.getText(sf));
}

function extractBaseTypes(
  node: ts.ClassDeclaration | ts.InterfaceDeclaration,
  sf: ts.SourceFile,
): string[] {
  if (!node.heritageClauses) return [];
  const result: string[] = [];
  for (const clause of node.heritageClauses) {
    for (const type of clause.types) {
      result.push(type.getText(sf));
    }
  }
  return result;
}

function typeParamsToString(
  params: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
  sf: ts.SourceFile,
): string {
  if (!params || params.length === 0) return "";
  return "<" + params.map(p => p.getText(sf)).join(", ") + ">";
}

function paramsToString(
  params: ts.NodeArray<ts.ParameterDeclaration>,
  sf: ts.SourceFile,
): string {
  return params.map(p => p.getText(sf)).join(", ");
}

function returnTypeToString(
  node: ts.SignatureDeclaration,
  sf: ts.SourceFile,
): string {
  if (!node.type) return "";
  return ": " + node.type.getText(sf);
}

// ── Signature builders ──────────────────────────────────────────────────────

function modifierPrefix(node: ts.Node): string {
  const parts: string[] = [];
  if (isExported(node)) parts.push("export");
  if (hasModifier(node, ts.SyntaxKind.DefaultKeyword)) parts.push("default");
  if (hasModifier(node, ts.SyntaxKind.DeclareKeyword)) parts.push("declare");
  if (hasModifier(node, ts.SyntaxKind.AbstractKeyword)) parts.push("abstract");
  if (hasModifier(node, ts.SyntaxKind.AsyncKeyword)) parts.push("async");
  if (isNodeStatic(node)) parts.push("static");
  if (hasModifier(node, ts.SyntaxKind.ReadonlyKeyword)) parts.push("readonly");

  const vis = extractVisibility(node);
  if (vis !== "public") parts.push(vis);

  return parts.length > 0 ? parts.join(" ") + " " : "";
}

function classSignature(node: ts.ClassDeclaration, sf: ts.SourceFile): string {
  const prefix = modifierPrefix(node);
  const name = node.name?.getText(sf) ?? "<anonymous>";
  const tp = typeParamsToString(node.typeParameters, sf);
  return `${prefix}class ${name}${tp}`;
}

function interfaceSignature(node: ts.InterfaceDeclaration, sf: ts.SourceFile): string {
  const prefix = modifierPrefix(node);
  const name = node.name.getText(sf);
  const tp = typeParamsToString(node.typeParameters, sf);
  return `${prefix}interface ${name}${tp}`;
}

function enumSignature(node: ts.EnumDeclaration, sf: ts.SourceFile): string {
  const prefix = modifierPrefix(node);
  const name = node.name.getText(sf);
  return `${prefix}enum ${name}`;
}

function methodSignature(node: ts.MethodDeclaration | ts.MethodSignature, sf: ts.SourceFile): string {
  const prefix = modifierPrefix(node);
  const name = node.name.getText(sf);
  const tp = typeParamsToString(node.typeParameters, sf);
  const params = paramsToString(node.parameters, sf);
  const ret = returnTypeToString(node, sf);
  return `${prefix}${name}${tp}(${params})${ret}`;
}

function constructorSignature(node: ts.ConstructorDeclaration, sf: ts.SourceFile): string {
  const vis = extractVisibility(node);
  const visStr = vis !== "public" ? vis + " " : "";
  const params = paramsToString(node.parameters, sf);
  return `${visStr}constructor(${params})`;
}

function propertySignature(
  node: ts.PropertyDeclaration | ts.PropertySignature,
  sf: ts.SourceFile,
): string {
  const prefix = modifierPrefix(node);
  const name = node.name.getText(sf);
  const type = node.type ? ": " + node.type.getText(sf) : "";
  return `${prefix}${name}${type}`;
}

function accessorSignature(
  node: ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
  sf: ts.SourceFile,
): string {
  const prefix = modifierPrefix(node);
  const kind = ts.isGetAccessorDeclaration(node) ? "get" : "set";
  const name = node.name.getText(sf);
  const params = paramsToString(node.parameters, sf);
  const ret = ts.isGetAccessorDeclaration(node) ? returnTypeToString(node, sf) : "";
  return `${prefix}${kind} ${name}(${params})${ret}`;
}

function fnSignature(node: ts.FunctionDeclaration, sf: ts.SourceFile): string {
  const prefix = modifierPrefix(node);
  const name = node.name?.getText(sf) ?? "<anonymous>";
  const tp = typeParamsToString(node.typeParameters, sf);
  const params = paramsToString(node.parameters, sf);
  const ret = returnTypeToString(node, sf);
  return `${prefix}function ${name}${tp}(${params})${ret}`;
}

function typeAliasSignature(node: ts.TypeAliasDeclaration, sf: ts.SourceFile): string {
  const prefix = modifierPrefix(node);
  const name = node.name.getText(sf);
  const tp = typeParamsToString(node.typeParameters, sf);
  const typeText = node.type.getText(sf);
  // Truncate long type bodies
  const body = typeText.length > 80 ? typeText.slice(0, 80) + "..." : typeText;
  return `${prefix}type ${name}${tp} = ${body}`;
}

function namespaceSignature(node: ts.ModuleDeclaration, sf: ts.SourceFile): string {
  const prefix = modifierPrefix(node);
  const name = node.name.getText(sf);
  return `${prefix}namespace ${name}`;
}

function varFnSignature(
  decl: ts.VariableDeclaration,
  stmt: ts.VariableStatement,
  sf: ts.SourceFile,
): string {
  const prefix = modifierPrefix(stmt);
  const kind = stmt.declarationList.flags & ts.NodeFlags.Const ? "const" : "let";
  const name = decl.name.getText(sf);
  const init = decl.initializer;
  if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
    const tp = typeParamsToString(init.typeParameters, sf);
    const params = paramsToString(init.parameters, sf);
    const ret = returnTypeToString(init, sf);
    return `${prefix}${kind} ${name}${tp} = (${params})${ret} => ...`;
  }
  const type = decl.type ? ": " + decl.type.getText(sf) : "";
  return `${prefix}${kind} ${name}${type}`;
}

// ── AST walking ─────────────────────────────────────────────────────────────

function visitClassMembers(node: ts.ClassDeclaration, sf: ts.SourceFile): CodeMember[] {
  const children: CodeMember[] = [];
  for (const m of node.members) {
    if (ts.isMethodDeclaration(m)) {
      children.push({
        type: "Method",
        signature: methodSignature(m, sf),
        lineNumber: getLineNumber(m, sf),
        isStatic: isNodeStatic(m),
        visibility: extractVisibility(m),
        docString: extractDocString(m, sf.text),
        baseTypes: [],
        attributes: extractDecorators(m, sf),
        children: [],
      });
    } else if (ts.isConstructorDeclaration(m)) {
      children.push({
        type: "Constructor",
        signature: constructorSignature(m, sf),
        lineNumber: getLineNumber(m, sf),
        isStatic: false,
        visibility: extractVisibility(m),
        docString: extractDocString(m, sf.text),
        baseTypes: [],
        attributes: [],
        children: [],
      });
    } else if (ts.isPropertyDeclaration(m)) {
      children.push({
        type: "Property",
        signature: propertySignature(m, sf),
        lineNumber: getLineNumber(m, sf),
        isStatic: isNodeStatic(m),
        visibility: extractVisibility(m),
        docString: extractDocString(m, sf.text),
        baseTypes: [],
        attributes: extractDecorators(m, sf),
        children: [],
      });
    } else if (ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) {
      children.push({
        type: "Property",
        signature: accessorSignature(m, sf),
        lineNumber: getLineNumber(m, sf),
        isStatic: isNodeStatic(m),
        visibility: extractVisibility(m),
        docString: extractDocString(m, sf.text),
        baseTypes: [],
        attributes: extractDecorators(m, sf),
        children: [],
      });
    }
  }
  return children;
}

function visitInterfaceMembers(node: ts.InterfaceDeclaration, sf: ts.SourceFile): CodeMember[] {
  const children: CodeMember[] = [];
  for (const m of node.members) {
    if (ts.isMethodSignature(m)) {
      children.push({
        type: "Method",
        signature: methodSignature(m, sf),
        lineNumber: getLineNumber(m, sf),
        isStatic: false,
        visibility: "public",
        docString: extractDocString(m, sf.text),
        baseTypes: [],
        attributes: [],
        children: [],
      });
    } else if (ts.isPropertySignature(m)) {
      children.push({
        type: "Property",
        signature: propertySignature(m, sf),
        lineNumber: getLineNumber(m, sf),
        isStatic: false,
        visibility: "public",
        docString: extractDocString(m, sf.text),
        baseTypes: [],
        attributes: [],
        children: [],
      });
    }
  }
  return children;
}

function visitTopLevel(sf: ts.SourceFile): CodeMember[] {
  const members: CodeMember[] = [];
  ts.forEachChild(sf, node => {
    visitNode(node as ts.Statement, sf, members);
  });
  return members;
}

function visitNode(node: ts.Statement, sf: ts.SourceFile, members: CodeMember[]): void {
  if (ts.isClassDeclaration(node)) {
    members.push({
      type: "Class",
      signature: classSignature(node, sf),
      lineNumber: getLineNumber(node, sf),
      isStatic: false,
      visibility: isExported(node) ? "public" : "private",
      docString: extractDocString(node, sf.text),
      baseTypes: extractBaseTypes(node, sf),
      attributes: extractDecorators(node, sf),
      children: visitClassMembers(node, sf),
    });
  } else if (ts.isInterfaceDeclaration(node)) {
    members.push({
      type: "Interface",
      signature: interfaceSignature(node, sf),
      lineNumber: getLineNumber(node, sf),
      isStatic: false,
      visibility: isExported(node) ? "public" : "private",
      docString: extractDocString(node, sf.text),
      baseTypes: extractBaseTypes(node, sf),
      attributes: [],
      children: visitInterfaceMembers(node, sf),
    });
  } else if (ts.isEnumDeclaration(node)) {
    const children: CodeMember[] = node.members.map(m => ({
      type: "Variant",
      signature: m.name.getText(sf) + (m.initializer ? " = " + m.initializer.getText(sf) : ""),
      lineNumber: getLineNumber(m, sf),
      isStatic: false,
      visibility: "public",
      docString: extractDocString(m, sf.text),
      baseTypes: [] as string[],
      attributes: [] as string[],
      children: [] as CodeMember[],
    }));
    members.push({
      type: "Enum",
      signature: enumSignature(node, sf),
      lineNumber: getLineNumber(node, sf),
      isStatic: false,
      visibility: isExported(node) ? "public" : "private",
      docString: extractDocString(node, sf.text),
      baseTypes: [],
      attributes: [],
      children,
    });
  } else if (ts.isFunctionDeclaration(node) && node.name) {
    members.push({
      type: "Fn",
      signature: fnSignature(node, sf),
      lineNumber: getLineNumber(node, sf),
      isStatic: true,
      visibility: isExported(node) ? "public" : "private",
      docString: extractDocString(node, sf.text),
      baseTypes: [],
      attributes: extractDecorators(node, sf),
      children: [],
    });
  } else if (ts.isTypeAliasDeclaration(node)) {
    members.push({
      type: "Type",
      signature: typeAliasSignature(node, sf),
      lineNumber: getLineNumber(node, sf),
      isStatic: false,
      visibility: isExported(node) ? "public" : "private",
      docString: extractDocString(node, sf.text),
      baseTypes: [],
      attributes: [],
      children: [],
    });
  } else if (ts.isModuleDeclaration(node)) {
    const body = node.body;
    let children: CodeMember[] = [];
    if (body && ts.isModuleBlock(body)) {
      body.statements.forEach(stmt => visitNode(stmt, sf, children));
    }
    members.push({
      type: "Namespace",
      signature: namespaceSignature(node, sf),
      lineNumber: getLineNumber(node, sf),
      isStatic: false,
      visibility: isExported(node) ? "public" : "private",
      docString: extractDocString(node, sf.text),
      baseTypes: [],
      attributes: [],
      children,
    });
  } else if (ts.isVariableStatement(node)) {
    visitVariableStatement(node, sf, members);
  }
}

function visitVariableStatement(
  node: ts.VariableStatement,
  sf: ts.SourceFile,
  members: CodeMember[],
): void {
  const exported = isExported(node);

  for (const decl of node.declarationList.declarations) {
    const init = decl.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
      members.push({
        type: "Fn",
        signature: varFnSignature(decl, node, sf),
        lineNumber: getLineNumber(node, sf),
        isStatic: true,
        visibility: exported ? "public" : "private",
        docString: extractDocString(node, sf.text),
        baseTypes: [],
        attributes: [],
        children: [],
      });
    } else if (
      (node.declarationList.flags & ts.NodeFlags.Const) &&
      ts.isIdentifier(decl.name)
    ) {
      members.push({
        type: "Const",
        signature: varFnSignature(decl, node, sf),
        lineNumber: getLineNumber(node, sf),
        isStatic: false,
        visibility: exported ? "public" : "private",
        docString: extractDocString(node, sf.text),
        baseTypes: [],
        attributes: [],
        children: [],
      });
    }
  }
}

// ── Text format ─────────────────────────────────────────────────────────────

function toText(output: OutputRoot): string {
  const lines: string[] = [];
  const s = output.summary;
  lines.push(`# Summary: ${s.files} files, ${s.namespaces} namespaces, ${s.types} types, ${s.methods} methods`);
  lines.push("");

  for (const file of output.files) {
    lines.push(`# ${file.filePath}`);
    for (const m of file.members) {
      memberToText(m, "  ", lines);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function memberToText(m: CodeMember, indent: string, lines: string[]): void {
  const doc = m.docString ? ` // ${m.docString}` : "";
  lines.push(`${indent}[${m.type}] ${m.signature} :${m.lineNumber}${doc}`);
  for (const child of m.children) {
    memberToText(child, indent + "  ", lines);
  }
}

// ── YAML format ─────────────────────────────────────────────────────────────

function toYaml(output: OutputRoot): string {
  const lines: string[] = [];
  lines.push("summary:");
  lines.push(`  files: ${output.summary.files}`);
  lines.push(`  namespaces: ${output.summary.namespaces}`);
  lines.push(`  types: ${output.summary.types}`);
  lines.push(`  methods: ${output.summary.methods}`);
  lines.push("");
  lines.push("files:");

  for (const file of output.files) {
    lines.push(`  - path: "${file.filePath}"`);
    lines.push("    members:");
    for (const m of file.members) {
      memberToYaml(m, "      ", lines);
    }
  }
  return lines.join("\n");
}

function yamlEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function memberToYaml(m: CodeMember, indent: string, lines: string[]): void {
  lines.push(`${indent}- type: ${m.type}`);
  lines.push(`${indent}  signature: "${yamlEscape(m.signature)}"`);
  lines.push(`${indent}  lineNumber: ${m.lineNumber}`);
  lines.push(`${indent}  isStatic: ${m.isStatic}`);
  lines.push(`${indent}  visibility: ${m.visibility}`);
  if (m.docString) lines.push(`${indent}  docString: "${yamlEscape(m.docString)}"`);
  if (m.baseTypes.length > 0) {
    lines.push(`${indent}  baseTypes: [${m.baseTypes.map(t => `"${yamlEscape(t)}"`).join(", ")}]`);
  }
  if (m.attributes.length > 0) {
    lines.push(`${indent}  attributes: [${m.attributes.map(a => `"${yamlEscape(a)}"`).join(", ")}]`);
  }
  if (m.children.length > 0) {
    lines.push(`${indent}  children:`);
    for (const c of m.children) {
      memberToYaml(c, indent + "    ", lines);
    }
  }
}

// ── Summary counting ────────────────────────────────────────────────────────

function countSummary(files: FileNode[]): { namespaces: number; types: number; methods: number } {
  let namespaces = 0, types = 0, methods = 0;

  function count(members: CodeMember[]) {
    for (const m of members) {
      switch (m.type) {
        case "Namespace": namespaces++; break;
        case "Class": case "Interface": case "Enum": case "Type": types++; break;
        case "Fn": case "Method": case "Constructor": methods++; break;
      }
      count(m.children);
    }
  }

  for (const f of files) count(f.members);
  return { namespaces, types, methods };
}

// ── Main ────────────────────────────────────────────────────────────────────

const files = collectFiles(rootPath);

if (files.length === 0) {
  const empty: OutputRoot = {
    summary: { files: 0, namespaces: 0, types: 0, methods: 0 },
    files: [],
  };
  switch (format) {
    case "text": console.log(toText(empty)); break;
    case "yaml": console.log(toYaml(empty)); break;
    default: console.log(JSON.stringify(empty, null, 2));
  }
  process.exit(0);
}

const fileNodes: FileNode[] = [];
const isFile = statSync(rootPath).isFile();
const relBase = isFile ? dirname(rootPath) : rootPath;

for (const filePath of files) {
  try {
    const source = readFileSync(filePath, "utf-8");
    const scriptKind = filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
    const members = visitTopLevel(sf);

    if (members.length > 0) {
      fileNodes.push({
        filePath: relative(relBase, filePath),
        members,
      });
    }
  } catch (e: any) {
    console.error(`Error parsing ${filePath}: ${e.message}`);
  }
}

const { namespaces, types, methods } = countSummary(fileNodes);
const output: OutputRoot = {
  summary: { files: fileNodes.length, namespaces, types, methods },
  files: fileNodes,
};

if (stdoutMode) {
  switch (format) {
    case "text":
      console.log(toText(output));
      break;
    case "yaml":
      console.log(toYaml(output));
      break;
    default:
      console.log(JSON.stringify(output, null, 2));
  }
} else {
  const { mkdirSync, writeFileSync } = await import("fs");
  mkdirSync(outputDir, { recursive: true });
  const ext = format === "json" ? ".json" : format === "yaml" ? ".yaml" : ".txt";
  const outPath = join(outputDir, `typescript${ext}`);
  let content: string;
  switch (format) {
    case "text": content = toText(output); break;
    case "yaml": content = toYaml(output); break;
    default: content = JSON.stringify(output, null, 2);
  }
  writeFileSync(outPath, content);
  console.error(`Wrote ${outPath}`);
}
