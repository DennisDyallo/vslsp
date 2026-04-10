using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

class Program
{
    static void Main(string[] args)
    {
        string path = Directory.GetCurrentDirectory();
        string format = "text";
        string outputDir = Path.Combine(Directory.GetCurrentDirectory(), "codebase_ast");
        bool stdoutMode = false;
        string visibility = "public";

        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] is "--format" or "-f" && i + 1 < args.Length)
            {
                format = args[++i].ToLower();
                if (format is not ("text" or "json" or "yaml"))
                {
                    Console.Error.WriteLine("Invalid format. Use: text, json, or yaml");
                    return;
                }
            }
            else if (args[i] == "--output" && i + 1 < args.Length)
                outputDir = args[++i];
            else if (args[i] == "--stdout")
                stdoutMode = true;
            else if (args[i] == "--visibility" && i + 1 < args.Length)
            {
                visibility = args[++i].ToLower();
                if (visibility is not ("all" or "public"))
                {
                    Console.Error.WriteLine("Invalid visibility. Use: all or public");
                    return;
                }
            }
            else if (!args[i].StartsWith("--"))
                path = args[i];
        }

        var projects = Directory.GetFiles(path, "*.csproj", SearchOption.AllDirectories)
                                .Where(f => !f.Contains(Path.DirectorySeparatorChar + "obj" + Path.DirectorySeparatorChar)
                                         && !f.Contains(Path.DirectorySeparatorChar + "bin" + Path.DirectorySeparatorChar))
                                .ToList();

        if (projects.Count == 0)
        {
            Console.Error.WriteLine("No .csproj files found. Scanning entire directory as single project...");
            projects.Add(path);
        }

        if (!stdoutMode)
        {
            Directory.CreateDirectory(outputDir);
            Console.WriteLine($"Found {projects.Count} project(s) in {path}");
        }

        int totalProjects = 0, totalFiles = 0, totalNamespaces = 0, totalTypes = 0, totalMethods = 0;
        var allFileNodes = new List<FileNode>();

        foreach (var project in projects)
        {
            string projectDir = File.Exists(project) ? Path.GetDirectoryName(project)! : project;
            string projectName = File.Exists(project) ? Path.GetFileNameWithoutExtension(project) : "codebase";

            var files = Directory.GetFiles(projectDir, "*.cs", SearchOption.AllDirectories)
                                 .Where(f => !f.Contains(Path.DirectorySeparatorChar + "obj" + Path.DirectorySeparatorChar)
                                          && !f.Contains(Path.DirectorySeparatorChar + "bin" + Path.DirectorySeparatorChar));

            var codebaseMap = new List<FileNode>();

            foreach (var file in files)
            {
                try
                {
                    var code = File.ReadAllText(file);
                    var tree = CSharpSyntaxTree.ParseText(code);
                    var root = tree.GetRoot();
                    var collector = new StructureCollector(Path.GetRelativePath(projectDir, file), filterVisibility: visibility != "all");
                    collector.Visit(root);
                    if (collector.RootNode.Members.Any())
                        codebaseMap.Add(collector.RootNode);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"Error parsing {file}: {ex.Message}");
                }
            }

            if (codebaseMap.Count == 0) continue;

            totalProjects++;
            totalFiles += codebaseMap.Count;
            CountMembers(codebaseMap, ref totalNamespaces, ref totalTypes, ref totalMethods);

            if (stdoutMode)
            {
                allFileNodes.AddRange(codebaseMap);
            }
            else
            {
                string ext = format switch { "json" => ".json", "yaml" => ".yaml", _ => ".txt" };
                string outputPath = Path.Combine(outputDir, $"{projectName}{ext}");
                switch (format)
                {
                    case "json":  WriteJsonOutput(outputPath, codebaseMap, totalFiles, totalNamespaces, totalTypes, totalMethods); break;
                    case "yaml":  WriteYamlOutput(outputPath, codebaseMap, totalFiles, totalNamespaces, totalTypes, totalMethods); break;
                    default:      WriteTextOutput(outputPath, codebaseMap, totalFiles, totalNamespaces, totalTypes, totalMethods); break;
                }
                Console.WriteLine($"  ✅ {projectName}: {codebaseMap.Count} files");
            }
        }

        if (stdoutMode)
        {
            switch (format)
            {
                case "json":
                    var output = new OutputRoot
                    {
                        Summary = new Summary { Files = totalFiles, Namespaces = totalNamespaces, Types = totalTypes, Methods = totalMethods },
                        FileNodes = allFileNodes
                    };
                    Console.WriteLine(JsonSerializer.Serialize(output, AppJsonContext.Default.OutputRoot));
                    break;
                case "yaml":
                    WriteYamlToWriter(Console.Out, allFileNodes, totalFiles, totalNamespaces, totalTypes, totalMethods);
                    break;
                default:
                    WriteTextToWriter(Console.Out, allFileNodes, totalFiles, totalNamespaces, totalTypes, totalMethods);
                    break;
            }
        }
        else
        {
            Console.WriteLine($"\n📁 Output: {outputDir}");
            Console.WriteLine($"# Summary: {totalProjects} projects, {totalFiles} files, {totalNamespaces} namespaces, {totalTypes} types, {totalMethods} methods");
        }
    }

    static void CountMembers(List<FileNode> files, ref int namespaces, ref int types, ref int methods)
    {
        foreach (var file in files)
            CountMembersRecursive(file.Members, ref namespaces, ref types, ref methods);
    }

    static void CountMembersRecursive(List<CodeMember> members, ref int namespaces, ref int types, ref int methods)
    {
        foreach (var m in members)
        {
            if (m.Type == "Namespace") namespaces++;
            else if (m.Type is "Class" or "Struct" or "Interface" or "Record" or "Enum") types++;
            else if (m.Type is "Method" or "Constructor") methods++;
            // Field, Property, Variant excluded from summary (consistent with RustMapper)
            CountMembersRecursive(m.Children, ref namespaces, ref types, ref methods);
        }
    }

    static void WriteJsonOutput(string path, List<FileNode> files, int totalFiles, int namespaces, int types, int methods)
    {
        var output = new OutputRoot
        {
            Summary = new Summary { Files = totalFiles, Namespaces = namespaces, Types = types, Methods = methods },
            FileNodes = files
        };
        File.WriteAllText(path, JsonSerializer.Serialize(output, AppJsonContext.Default.OutputRoot));
    }

    static void WriteTextOutput(string path, List<FileNode> files, int totalFiles, int namespaces, int types, int methods)
    {
        var sb = new StringBuilder();
        BuildText(sb, files, totalFiles, namespaces, types, methods);
        File.WriteAllText(path, sb.ToString());
    }

    static void WriteTextToWriter(TextWriter writer, List<FileNode> files, int totalFiles, int namespaces, int types, int methods)
    {
        var sb = new StringBuilder();
        BuildText(sb, files, totalFiles, namespaces, types, methods);
        writer.Write(sb.ToString());
    }

    static void BuildText(StringBuilder sb, List<FileNode> files, int totalFiles, int namespaces, int types, int methods)
    {
        sb.AppendLine($"# Summary: {totalFiles} files, {namespaces} namespaces, {types} types, {methods} methods");
        sb.AppendLine();
        foreach (var file in files)
        {
            sb.AppendLine($"# {file.FilePath}");
            WriteMembersCompact(sb, file.Members, 1);
            sb.AppendLine();
        }
    }

    static void WriteMembersCompact(StringBuilder sb, List<CodeMember> members, int depth)
    {
        string indent = new string(' ', depth * 2);
        foreach (var m in members)
        {
            string typeLabel = m.IsStatic ? $"{m.Type}:static" : m.Type;
            string lineNum = m.LineNumber > 0 ? $" :{m.LineNumber}" : "";
            string baseTypes = m.BaseTypes.Count > 0 ? $" : {string.Join(", ", m.BaseTypes)}" : "";
            string attrs = m.Attributes.Count > 0 ? $" [{string.Join(", ", m.Attributes)}]" : "";
            string doc = !string.IsNullOrEmpty(m.DocString) ? $" // {m.DocString}" : "";
            sb.AppendLine($"{indent}[{typeLabel}] {m.Signature}{baseTypes}{attrs}{lineNum}{doc}");
            if (m.Children.Count > 0)
                WriteMembersCompact(sb, m.Children, depth + 1);
        }
    }

    static void WriteYamlOutput(string path, List<FileNode> files, int totalFiles, int namespaces, int types, int methods)
    {
        var sb = new StringBuilder();
        BuildYaml(sb, files, totalFiles, namespaces, types, methods);
        File.WriteAllText(path, sb.ToString());
    }

    static void WriteYamlToWriter(TextWriter writer, List<FileNode> files, int totalFiles, int namespaces, int types, int methods)
    {
        var sb = new StringBuilder();
        BuildYaml(sb, files, totalFiles, namespaces, types, methods);
        writer.Write(sb.ToString());
    }

    static void BuildYaml(StringBuilder sb, List<FileNode> files, int totalFiles, int namespaces, int types, int methods)
    {
        sb.AppendLine("summary:");
        sb.AppendLine($"  files: {totalFiles}");
        sb.AppendLine($"  namespaces: {namespaces}");
        sb.AppendLine($"  types: {types}");
        sb.AppendLine($"  methods: {methods}");
        sb.AppendLine();
        sb.AppendLine("files:");
        foreach (var file in files)
        {
            sb.AppendLine($"  - path: \"{EscapeYaml(file.FilePath)}\"");
            sb.AppendLine("    members:");
            WriteYamlMembers(sb, file.Members, 3);
        }
    }

    static void WriteYamlMembers(StringBuilder sb, List<CodeMember> members, int depth)
    {
        string indent = new string(' ', depth * 2);
        foreach (var m in members)
        {
            sb.AppendLine($"{indent}- type: {m.Type}");
            sb.AppendLine($"{indent}  signature: \"{EscapeYaml(m.Signature)}\"");
            sb.AppendLine($"{indent}  lineNumber: {m.LineNumber}");
            sb.AppendLine($"{indent}  isStatic: {m.IsStatic.ToString().ToLower()}");
            sb.AppendLine($"{indent}  visibility: \"{m.Visibility}\"");
            sb.AppendLine($"{indent}  docString: \"{EscapeYaml(m.DocString)}\"");
            if (m.BaseTypes.Count > 0)
            {
                sb.AppendLine($"{indent}  baseTypes:");
                foreach (var bt in m.BaseTypes)
                    sb.AppendLine($"{indent}    - \"{EscapeYaml(bt)}\"");
            }
            else
            {
                sb.AppendLine($"{indent}  baseTypes: []");
            }
            if (m.Attributes.Count > 0)
            {
                sb.AppendLine($"{indent}  attributes:");
                foreach (var attr in m.Attributes)
                    sb.AppendLine($"{indent}    - \"{EscapeYaml(attr)}\"");
            }
            else
            {
                sb.AppendLine($"{indent}  attributes: []");
            }
            if (m.Children.Count > 0)
            {
                sb.AppendLine($"{indent}  children:");
                WriteYamlMembers(sb, m.Children, depth + 2);
            }
            else
            {
                sb.AppendLine($"{indent}  children: []");
            }
        }
    }

    static string EscapeYaml(string value)
        => value.Replace("\\", "\\\\").Replace("\"", "\\\"");
}

// ── Data Structures ───────────────────────────────────────────────────────────

public class FileNode
{
    [JsonPropertyName("filePath")]
    public string FilePath { get; set; } = "";

    [JsonPropertyName("members")]
    public List<CodeMember> Members { get; set; } = new();
}

public class CodeMember
{
    [JsonPropertyName("type")]
    public string Type { get; set; } = "";

    [JsonPropertyName("signature")]
    public string Signature { get; set; } = "";

    [JsonPropertyName("lineNumber")]
    public int LineNumber { get; set; }

    [JsonPropertyName("isStatic")]
    public bool IsStatic { get; set; }

    [JsonPropertyName("visibility")]
    public string Visibility { get; set; } = "";

    [JsonPropertyName("docString")]
    public string DocString { get; set; } = "";

    [JsonPropertyName("baseTypes")]
    public List<string> BaseTypes { get; set; } = new();

    [JsonPropertyName("attributes")]
    public List<string> Attributes { get; set; } = new();

    [JsonPropertyName("children")]
    public List<CodeMember> Children { get; set; } = new();
}

public class Summary
{
    [JsonPropertyName("files")]
    public int Files { get; set; }

    [JsonPropertyName("namespaces")]
    public int Namespaces { get; set; }

    [JsonPropertyName("types")]
    public int Types { get; set; }

    [JsonPropertyName("methods")]
    public int Methods { get; set; }
}

public class OutputRoot
{
    [JsonPropertyName("summary")]
    public Summary Summary { get; set; } = new();

    [JsonPropertyName("files")]
    public List<FileNode> FileNodes { get; set; } = new();
}

[JsonSerializable(typeof(OutputRoot))]
[JsonSourceGenerationOptions(WriteIndented = true)]
internal partial class AppJsonContext : JsonSerializerContext { }

// ── Roslyn Syntax Walker ──────────────────────────────────────────────────────

public class StructureCollector : CSharpSyntaxWalker
{
    public FileNode RootNode { get; }
    private Stack<CodeMember> _stack = new();
    private readonly bool _filterVisibility;

    public StructureCollector(string filePath, bool filterVisibility = true)
    {
        RootNode = new FileNode { FilePath = filePath };
        _filterVisibility = filterVisibility;
    }

    // ── Visibility / modifier helpers ─────────────────────────────────────────

    private static bool IsPublicOrInternal(SyntaxTokenList modifiers)
    {
        if (modifiers.Count == 0) return true; // default visibility passes through
        return modifiers.Any(m => m.IsKind(SyntaxKind.PublicKeyword) || m.IsKind(SyntaxKind.InternalKeyword));
    }

    private static bool IsStatic(SyntaxTokenList modifiers)
        => modifiers.Any(m => m.IsKind(SyntaxKind.StaticKeyword));

    /// Returns the access level as a string matching RustMapper's vocabulary where possible.
    private static string ExtractVisibility(SyntaxTokenList modifiers)
    {
        if (modifiers.Any(m => m.IsKind(SyntaxKind.PublicKeyword))) return "public";
        if (modifiers.Any(m => m.IsKind(SyntaxKind.PrivateKeyword)))
            return modifiers.Any(m => m.IsKind(SyntaxKind.ProtectedKeyword)) ? "private protected" : "private";
        if (modifiers.Any(m => m.IsKind(SyntaxKind.ProtectedKeyword)))
            return modifiers.Any(m => m.IsKind(SyntaxKind.InternalKeyword)) ? "protected internal" : "protected";
        if (modifiers.Any(m => m.IsKind(SyntaxKind.InternalKeyword))) return "internal";
        return "private"; // C# default for members; types default to internal but we unify as private
    }

    /// Builds the full modifier prefix for a signature string (visibility + other modifiers).
    private static string BuildModifierPrefix(SyntaxTokenList modifiers)
    {
        var parts = new List<string>();

        // Access level first (matches C# source code order)
        if (modifiers.Any(m => m.IsKind(SyntaxKind.PublicKeyword)))
            parts.Add("public");
        else if (modifiers.Any(m => m.IsKind(SyntaxKind.PrivateKeyword)))
            parts.Add(modifiers.Any(m => m.IsKind(SyntaxKind.ProtectedKeyword)) ? "private protected" : "private");
        else if (modifiers.Any(m => m.IsKind(SyntaxKind.ProtectedKeyword)))
            parts.Add(modifiers.Any(m => m.IsKind(SyntaxKind.InternalKeyword)) ? "protected internal" : "protected");
        else if (modifiers.Any(m => m.IsKind(SyntaxKind.InternalKeyword)))
            parts.Add("internal");

        // Other modifiers in source order
        if (modifiers.Any(m => m.IsKind(SyntaxKind.StaticKeyword)))   parts.Add("static");
        if (modifiers.Any(m => m.IsKind(SyntaxKind.AbstractKeyword))) parts.Add("abstract");
        if (modifiers.Any(m => m.IsKind(SyntaxKind.VirtualKeyword)))  parts.Add("virtual");
        if (modifiers.Any(m => m.IsKind(SyntaxKind.OverrideKeyword))) parts.Add("override");
        if (modifiers.Any(m => m.IsKind(SyntaxKind.SealedKeyword)))   parts.Add("sealed");
        if (modifiers.Any(m => m.IsKind(SyntaxKind.AsyncKeyword)))    parts.Add("async");
        if (modifiers.Any(m => m.IsKind(SyntaxKind.ReadOnlyKeyword))) parts.Add("readonly");
        if (modifiers.Any(m => m.IsKind(SyntaxKind.ConstKeyword)))    parts.Add("const");
        if (modifiers.Any(m => m.IsKind(SyntaxKind.NewKeyword)))      parts.Add("new");
        if (modifiers.Any(m => m.IsKind(SyntaxKind.PartialKeyword)))  parts.Add("partial");

        return parts.Count > 0 ? string.Join(" ", parts) + " " : "";
    }

    private static string TypeParamsToString(TypeParameterListSyntax? tpl)
        => tpl == null || tpl.Parameters.Count == 0 ? "" : tpl.ToString();

    // ── Doc / attribute helpers ───────────────────────────────────────────────

    private static string ExtractFirstSentenceDoc(SyntaxNode node)
    {
        var trivia = node.GetLeadingTrivia();
        var xmlComments = trivia
            .Where(t => t.IsKind(SyntaxKind.SingleLineDocumentationCommentTrivia) ||
                        t.IsKind(SyntaxKind.MultiLineDocumentationCommentTrivia))
            .Select(t => t.GetStructure())
            .OfType<DocumentationCommentTriviaSyntax>()
            .FirstOrDefault();

        if (xmlComments == null) return "";

        var summaryElement = xmlComments.ChildNodes()
            .OfType<XmlElementSyntax>()
            .FirstOrDefault(e => e.StartTag.Name.ToString() == "summary");

        if (summaryElement == null) return "";

        var content = string.Join(" ", summaryElement.Content
            .Select(c => c.ToString().Trim())
            .Where(s => !string.IsNullOrEmpty(s)));

        content = Regex.Replace(content, @"<[^>]+>", "");
        content = Regex.Replace(content, @"\s+", " ").Trim();

        int periodIdx = content.IndexOf('.');
        if (periodIdx > 0 && periodIdx < 100)
            content = content[..(periodIdx + 1)];
        else if (content.Length > 100)
            content = content[..100] + "...";

        return content;
    }

    /// Extract attributes with actual argument text (not placeholder "...").
    private static List<string> ExtractAttributes(SyntaxList<AttributeListSyntax> attributeLists)
    {
        var attrs = new List<string>();
        foreach (var attrList in attributeLists)
        {
            foreach (var attr in attrList.Attributes)
            {
                var name = attr.Name.ToString();
                if (attr.ArgumentList != null && attr.ArgumentList.Arguments.Count > 0)
                {
                    var args = attr.ArgumentList.Arguments.Select(a => a.ToString());
                    attrs.Add($"{name}({string.Join(", ", args)})");
                }
                else
                {
                    attrs.Add(name);
                }
            }
        }
        return attrs;
    }

    private static List<string> ExtractBaseTypes(BaseListSyntax? baseList)
    {
        if (baseList == null || baseList.Types.Count == 0) return new();
        return baseList.Types.Select(t => t.Type.ToString()).ToList();
    }

    // ── Stack push helper ─────────────────────────────────────────────────────

    private void PushMember(string type, string signature, SyntaxNode node, SyntaxTokenList modifiers,
        SyntaxList<AttributeListSyntax>? attributes = null, BaseListSyntax? baseList = null,
        string? visibilityOverride = null)
    {
        var member = new CodeMember
        {
            Type = type,
            Signature = signature,
            LineNumber = node.GetLocation().GetLineSpan().StartLinePosition.Line + 1,
            IsStatic = IsStatic(modifiers),
            Visibility = visibilityOverride ?? ExtractVisibility(modifiers),
            DocString = ExtractFirstSentenceDoc(node),
            Attributes = attributes.HasValue ? ExtractAttributes(attributes.Value) : new(),
            BaseTypes = ExtractBaseTypes(baseList),
        };

        if (_stack.Count > 0)
            _stack.Peek().Children.Add(member);
        else
            RootNode.Members.Add(member);

        _stack.Push(member);
    }

    // ── Namespace ─────────────────────────────────────────────────────────────

    public override void VisitNamespaceDeclaration(NamespaceDeclarationSyntax node)
    {
        var nsName = node.Name.ToString();
        PushMember("Namespace", nsName, node, default, visibilityOverride: "");
        base.VisitNamespaceDeclaration(node);
        _stack.Pop();
    }

    public override void VisitFileScopedNamespaceDeclaration(FileScopedNamespaceDeclarationSyntax node)
    {
        var nsName = node.Name.ToString();
        PushMember("Namespace", nsName, node, default, visibilityOverride: "");
        base.VisitFileScopedNamespaceDeclaration(node);
        _stack.Pop();
    }

    // ── Types ─────────────────────────────────────────────────────────────────

    public override void VisitClassDeclaration(ClassDeclarationSyntax node)
    {
        if (_filterVisibility && !IsPublicOrInternal(node.Modifiers)) return;
        string modPrefix = BuildModifierPrefix(node.Modifiers);
        string typeParams = TypeParamsToString(node.TypeParameterList);
        PushMember("Class", $"{modPrefix}class {node.Identifier.Text}{typeParams}",
            node, node.Modifiers, node.AttributeLists, node.BaseList);
        base.VisitClassDeclaration(node);
        _stack.Pop();
    }

    public override void VisitStructDeclaration(StructDeclarationSyntax node)
    {
        if (_filterVisibility && !IsPublicOrInternal(node.Modifiers)) return;
        string modPrefix = BuildModifierPrefix(node.Modifiers);
        string typeParams = TypeParamsToString(node.TypeParameterList);
        PushMember("Struct", $"{modPrefix}struct {node.Identifier.Text}{typeParams}",
            node, node.Modifiers, node.AttributeLists, node.BaseList);
        base.VisitStructDeclaration(node);
        _stack.Pop();
    }

    public override void VisitInterfaceDeclaration(InterfaceDeclarationSyntax node)
    {
        if (_filterVisibility && !IsPublicOrInternal(node.Modifiers)) return;
        string modPrefix = BuildModifierPrefix(node.Modifiers);
        string typeParams = TypeParamsToString(node.TypeParameterList);
        PushMember("Interface", $"{modPrefix}interface {node.Identifier.Text}{typeParams}",
            node, node.Modifiers, node.AttributeLists, node.BaseList);
        base.VisitInterfaceDeclaration(node);
        _stack.Pop();
    }

    public override void VisitRecordDeclaration(RecordDeclarationSyntax node)
    {
        if (_filterVisibility && !IsPublicOrInternal(node.Modifiers)) return;
        string modPrefix = BuildModifierPrefix(node.Modifiers);
        string typeParams = TypeParamsToString(node.TypeParameterList);
        string paramList = node.ParameterList?.ToString() ?? "";
        // record struct vs record class
        string keyword = node.ClassOrStructKeyword.IsKind(SyntaxKind.StructKeyword) ? "record struct" : "record";
        PushMember("Record", $"{modPrefix}{keyword} {node.Identifier.Text}{typeParams}{paramList}",
            node, node.Modifiers, node.AttributeLists, node.BaseList);
        base.VisitRecordDeclaration(node);
        _stack.Pop();
    }

    public override void VisitEnumDeclaration(EnumDeclarationSyntax node)
    {
        if (_filterVisibility && !IsPublicOrInternal(node.Modifiers)) return;
        string modPrefix = BuildModifierPrefix(node.Modifiers);
        string sig = $"{modPrefix}enum {node.Identifier.Text}";

        var member = new CodeMember
        {
            Type = "Enum",
            Signature = sig,
            LineNumber = node.GetLocation().GetLineSpan().StartLinePosition.Line + 1,
            IsStatic = false,
            Visibility = ExtractVisibility(node.Modifiers),
            DocString = ExtractFirstSentenceDoc(node),
            Attributes = ExtractAttributes(node.AttributeLists),
            BaseTypes = ExtractBaseTypes(node.BaseList),
        };

        // Emit each enum member as a Variant child (parity with RustMapper)
        foreach (var enumMember in node.Members)
        {
            string variantSig = enumMember.EqualsValue != null
                ? $"{enumMember.Identifier.Text} = {enumMember.EqualsValue.Value}"
                : enumMember.Identifier.Text;
            member.Children.Add(new CodeMember
            {
                Type = "Variant",
                Signature = variantSig,
                LineNumber = enumMember.GetLocation().GetLineSpan().StartLinePosition.Line + 1,
                IsStatic = false,
                Visibility = "public",
                DocString = ExtractFirstSentenceDoc(enumMember),
                Attributes = ExtractAttributes(enumMember.AttributeLists),
            });
        }

        if (_stack.Count > 0)
            _stack.Peek().Children.Add(member);
        else
            RootNode.Members.Add(member);
        // No recursion — enum body is fully captured above
    }

    // ── Members ───────────────────────────────────────────────────────────────

    public override void VisitConstructorDeclaration(ConstructorDeclarationSyntax node)
    {
        if (_filterVisibility && !IsPublicOrInternal(node.Modifiers)) return;
        string modPrefix = BuildModifierPrefix(node.Modifiers);
        PushMember("Constructor", $"{modPrefix}{node.Identifier.Text}{node.ParameterList}",
            node, node.Modifiers, node.AttributeLists);
        _stack.Pop();
    }

    public override void VisitMethodDeclaration(MethodDeclarationSyntax node)
    {
        if (_filterVisibility && !IsPublicOrInternal(node.Modifiers)) return;
        string modPrefix = BuildModifierPrefix(node.Modifiers);
        string typeParams = TypeParamsToString(node.TypeParameterList);
        string sig = $"{modPrefix}{node.ReturnType} {node.Identifier.Text}{typeParams}{node.ParameterList}";
        PushMember("Method", sig, node, node.Modifiers, node.AttributeLists);
        _stack.Pop();
    }

    public override void VisitPropertyDeclaration(PropertyDeclarationSyntax node)
    {
        if (_filterVisibility && !IsPublicOrInternal(node.Modifiers)) return;
        string modPrefix = BuildModifierPrefix(node.Modifiers);
        // Include accessor summary: { get; set; } / { get; } / { get; init; }
        string accessors = "";
        if (node.AccessorList != null)
        {
            var accs = node.AccessorList.Accessors.Select(a =>
            {
                string accMods = a.Modifiers.Count > 0 ? a.Modifiers.ToString() + " " : "";
                return $"{accMods}{a.Keyword.Text};";
            });
            accessors = " { " + string.Join(" ", accs) + " }";
        }
        PushMember("Property", $"{modPrefix}{node.Type} {node.Identifier.Text}{accessors}",
            node, node.Modifiers, node.AttributeLists);
        _stack.Pop();
    }

    public override void VisitFieldDeclaration(FieldDeclarationSyntax node)
    {
        if (_filterVisibility && !IsPublicOrInternal(node.Modifiers)) return;
        string modPrefix = BuildModifierPrefix(node.Modifiers);
        string typeStr = node.Declaration.Type.ToString();
        string vis = ExtractVisibility(node.Modifiers);
        string doc = ExtractFirstSentenceDoc(node);
        var attrs = ExtractAttributes(node.AttributeLists);
        bool isStatic = IsStatic(node.Modifiers);

        foreach (var variable in node.Declaration.Variables)
        {
            var member = new CodeMember
            {
                Type = "Field",
                Signature = $"{modPrefix}{typeStr} {variable.Identifier.Text}",
                LineNumber = variable.GetLocation().GetLineSpan().StartLinePosition.Line + 1,
                IsStatic = isStatic,
                Visibility = vis,
                DocString = doc,
                Attributes = attrs,
            };

            if (_stack.Count > 0)
                _stack.Peek().Children.Add(member);
            else
                RootNode.Members.Add(member);
        }
    }
}
