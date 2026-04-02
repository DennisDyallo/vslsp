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
        // Parse CLI arguments
        string path = Directory.GetCurrentDirectory();
        string format = "text";
        string outputDir = Path.Combine(Directory.GetCurrentDirectory(), "codebase_ast");
        
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
            {
                outputDir = args[++i];
            }
            else if (!args[i].StartsWith("--"))
            {
                path = args[i];
            }
        }
        
        // Find all .csproj files to auto-detect projects
        var projects = Directory.GetFiles(path, "*.csproj", SearchOption.AllDirectories)
                                .Where(f => !f.Contains(Path.DirectorySeparatorChar + "obj" + Path.DirectorySeparatorChar) 
                                         && !f.Contains(Path.DirectorySeparatorChar + "bin" + Path.DirectorySeparatorChar))
                                .ToList();

        if (projects.Count == 0)
        {
            Console.WriteLine("No .csproj files found. Scanning entire directory as single project...");
            projects.Add(path);
        }

        Directory.CreateDirectory(outputDir);
        Console.WriteLine($"Found {projects.Count} project(s) in {path}");

        // Summary counters
        int totalProjects = 0, totalFiles = 0, totalNamespaces = 0, totalTypes = 0, totalMethods = 0;

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
                    
                    var collector = new StructureCollector(Path.GetRelativePath(projectDir, file));
                    collector.Visit(root);
                    
                    if (collector.RootNode.Members.Any())
                    {
                        codebaseMap.Add(collector.RootNode);
                    }
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"Error parsing {file}: {ex.Message}");
                }
            }

            if (codebaseMap.Count == 0)
                continue;

            totalProjects++;
            totalFiles += codebaseMap.Count;
            CountMembers(codebaseMap, ref totalNamespaces, ref totalTypes, ref totalMethods);

            string ext = format switch { "json" => ".json", "yaml" => ".yaml", _ => ".txt" };
            string outputPath = Path.Combine(outputDir, $"{projectName}{ext}");

            switch (format)
            {
                case "json":
                    WriteJsonOutput(outputPath, codebaseMap, totalFiles, totalNamespaces, totalTypes, totalMethods);
                    break;
                case "yaml":
                    WriteYamlOutput(outputPath, codebaseMap, totalFiles, totalNamespaces, totalTypes, totalMethods);
                    break;
                default:
                    WriteTextOutput(outputPath, codebaseMap, totalFiles, totalNamespaces, totalTypes, totalMethods);
                    break;
            }
            
            Console.WriteLine($"  ✅ {projectName}: {codebaseMap.Count} files");
        }

        Console.WriteLine($"\n📁 Output: {outputDir}");
        Console.WriteLine($"# Summary: {totalProjects} projects, {totalFiles} files, {totalNamespaces} namespaces, {totalTypes} types, {totalMethods} methods");
    }

    static void CountMembers(List<FileNode> files, ref int namespaces, ref int types, ref int methods)
    {
        foreach (var file in files)
        {
            CountMembersRecursive(file.Members, ref namespaces, ref types, ref methods);
        }
    }

    static void CountMembersRecursive(List<CodeMember> members, ref int namespaces, ref int types, ref int methods)
    {
        foreach (var m in members)
        {
            if (m.Type == "Namespace") namespaces++;
            else if (m.Type is "Class" or "Interface" or "Record" or "Enum") types++;
            else if (m.Type is "Method" or "Constructor") methods++;
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
        sb.AppendLine($"# Summary: {totalFiles} files, {namespaces} namespaces, {types} types, {methods} methods");
        sb.AppendLine();
        
        foreach (var file in files)
        {
            sb.AppendLine($"# {file.FilePath}");
            WriteMembersCompact(sb, file.Members, 1);
            sb.AppendLine();
        }
        File.WriteAllText(path, sb.ToString());
    }
    
    static void WriteMembersCompact(StringBuilder sb, List<CodeMember> members, int depth)
    {
        string indent = new string(' ', depth * 2);
        foreach (var m in members)
        {
            string typeLabel = m.IsStatic ? $"{m.Type}:static" : m.Type;
            string lineNum = m.LineNumber > 0 ? $" :{m.LineNumber}" : "";
            string baseTypes = m.BaseTypes?.Count > 0 ? $" : {string.Join(", ", m.BaseTypes)}" : "";
            string attrs = m.Attributes?.Count > 0 ? $" [{string.Join(", ", m.Attributes)}]" : "";
            string doc = !string.IsNullOrEmpty(m.DocString) ? $" // {m.DocString}" : "";
            
            sb.AppendLine($"{indent}[{typeLabel}] {m.Signature}{baseTypes}{attrs}{lineNum}{doc}");
            if (m.Children.Count > 0)
                WriteMembersCompact(sb, m.Children, depth + 1);
        }
    }

    static void WriteYamlOutput(string path, List<FileNode> files, int totalFiles, int namespaces, int types, int methods)
    {
        var sb = new StringBuilder();
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
        File.WriteAllText(path, sb.ToString());
    }

    static void WriteYamlMembers(StringBuilder sb, List<CodeMember> members, int depth)
    {
        string indent = new string(' ', depth * 2);
        foreach (var m in members)
        {
            sb.AppendLine($"{indent}- type: {m.Type}");
            sb.AppendLine($"{indent}  signature: \"{EscapeYaml(m.Signature)}\"");
            if (m.LineNumber > 0)
                sb.AppendLine($"{indent}  line: {m.LineNumber}");
            if (m.IsStatic)
                sb.AppendLine($"{indent}  static: true");
            if (!string.IsNullOrEmpty(m.DocString))
                sb.AppendLine($"{indent}  doc: \"{EscapeYaml(m.DocString)}\"");
            if (m.BaseTypes?.Count > 0)
            {
                sb.AppendLine($"{indent}  baseTypes:");
                foreach (var bt in m.BaseTypes)
                    sb.AppendLine($"{indent}    - \"{EscapeYaml(bt)}\"");
            }
            if (m.Attributes?.Count > 0)
            {
                sb.AppendLine($"{indent}  attributes:");
                foreach (var attr in m.Attributes)
                    sb.AppendLine($"{indent}    - \"{EscapeYaml(attr)}\"");
            }
            if (m.Children.Count > 0)
            {
                sb.AppendLine($"{indent}  members:");
                WriteYamlMembers(sb, m.Children, depth + 2);
            }
        }
    }

    static string EscapeYaml(string value)
    {
        return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }
}

// ---------------- Data Structures ----------------

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
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public int LineNumber { get; set; }
    
    [JsonPropertyName("isStatic")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool IsStatic { get; set; }
    
    [JsonPropertyName("docString")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? DocString { get; set; }
    
    [JsonPropertyName("baseTypes")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<string>? BaseTypes { get; set; }
    
    [JsonPropertyName("attributes")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<string>? Attributes { get; set; }
    
    [JsonPropertyName("children")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
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
[JsonSourceGenerationOptions(WriteIndented = true, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
internal partial class AppJsonContext : JsonSerializerContext { }

// ---------------- Roslyn Syntax Walker ----------------

public class StructureCollector : CSharpSyntaxWalker
{
    public FileNode RootNode { get; }
    private Stack<CodeMember> _stack = new();
    private string? _currentNamespace;

    public StructureCollector(string filePath)
    {
        RootNode = new FileNode { FilePath = filePath };
    }

    private static bool IsPublicOrInternal(SyntaxTokenList modifiers)
    {
        // If no access modifier, default depends on context (internal for types, private for members)
        // We'll treat no modifier as potentially public/internal for top-level types
        if (modifiers.Count == 0) return true;
        
        return modifiers.Any(m => m.IsKind(SyntaxKind.PublicKeyword) || m.IsKind(SyntaxKind.InternalKeyword));
    }

    private static bool IsStatic(SyntaxTokenList modifiers)
    {
        return modifiers.Any(m => m.IsKind(SyntaxKind.StaticKeyword));
    }

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

        // Strip XML tags and normalize whitespace
        content = Regex.Replace(content, @"<[^>]+>", "");
        content = Regex.Replace(content, @"\s+", " ").Trim();
        
        // Truncate at first period or 100 chars
        int periodIdx = content.IndexOf('.');
        if (periodIdx > 0 && periodIdx < 100)
            content = content.Substring(0, periodIdx + 1);
        else if (content.Length > 100)
            content = content.Substring(0, 100) + "...";

        return content;
    }

    private static List<string>? ExtractAttributes(SyntaxList<AttributeListSyntax> attributeLists)
    {
        if (attributeLists.Count == 0) return null;
        
        var attrs = new List<string>();
        foreach (var attrList in attributeLists)
        {
            foreach (var attr in attrList.Attributes)
            {
                var name = attr.Name.ToString();
                if (attr.ArgumentList != null && attr.ArgumentList.Arguments.Count > 0)
                {
                    attrs.Add($"{name}(...)");
                }
                else
                {
                    attrs.Add(name);
                }
            }
        }
        return attrs.Count > 0 ? attrs : null;
    }

    private static List<string>? ExtractBaseTypes(BaseListSyntax? baseList)
    {
        if (baseList == null || baseList.Types.Count == 0) return null;
        return baseList.Types.Select(t => t.Type.ToString()).ToList();
    }

    private void PushMember(string type, string signature, SyntaxNode node, SyntaxTokenList modifiers, 
        SyntaxList<AttributeListSyntax>? attributes = null, BaseListSyntax? baseList = null)
    {
        var member = new CodeMember 
        { 
            Type = type, 
            Signature = signature,
            LineNumber = node.GetLocation().GetLineSpan().StartLinePosition.Line + 1,
            IsStatic = IsStatic(modifiers),
            DocString = ExtractFirstSentenceDoc(node),
            Attributes = attributes.HasValue ? ExtractAttributes(attributes.Value) : null,
            BaseTypes = ExtractBaseTypes(baseList)
        };

        if (string.IsNullOrEmpty(member.DocString)) member.DocString = null;

        if (_stack.Count > 0)
            _stack.Peek().Children.Add(member);
        else
            RootNode.Members.Add(member);

        _stack.Push(member);
    }

    // Phase 2.1: Namespace Context
    public override void VisitNamespaceDeclaration(NamespaceDeclarationSyntax node)
    {
        _currentNamespace = node.Name.ToString();
        PushMember("Namespace", _currentNamespace, node, default);
        base.VisitNamespaceDeclaration(node);
        _stack.Pop();
        _currentNamespace = null;
    }

    public override void VisitFileScopedNamespaceDeclaration(FileScopedNamespaceDeclarationSyntax node)
    {
        _currentNamespace = node.Name.ToString();
        PushMember("Namespace", _currentNamespace, node, default);
        base.VisitFileScopedNamespaceDeclaration(node);
        _stack.Pop();
        _currentNamespace = null;
    }

    // Phase 1.1 & 2.2: Classes with visibility filter and base types
    public override void VisitClassDeclaration(ClassDeclarationSyntax node)
    {
        if (!IsPublicOrInternal(node.Modifiers)) return;
        
        PushMember("Class", node.Identifier.Text, node, node.Modifiers, node.AttributeLists, node.BaseList);
        base.VisitClassDeclaration(node);
        _stack.Pop();
    }

    public override void VisitInterfaceDeclaration(InterfaceDeclarationSyntax node)
    {
        if (!IsPublicOrInternal(node.Modifiers)) return;
        
        PushMember("Interface", node.Identifier.Text, node, node.Modifiers, node.AttributeLists, node.BaseList);
        base.VisitInterfaceDeclaration(node);
        _stack.Pop();
    }

    // Phase 3.1: Records
    public override void VisitRecordDeclaration(RecordDeclarationSyntax node)
    {
        if (!IsPublicOrInternal(node.Modifiers)) return;
        
        string sig = node.ParameterList != null 
            ? $"{node.Identifier}{node.ParameterList}" 
            : node.Identifier.Text;
        PushMember("Record", sig, node, node.Modifiers, node.AttributeLists, node.BaseList);
        base.VisitRecordDeclaration(node);
        _stack.Pop();
    }

    // Phase 3.2: Enums
    public override void VisitEnumDeclaration(EnumDeclarationSyntax node)
    {
        if (!IsPublicOrInternal(node.Modifiers)) return;
        
        var memberNames = node.Members.Select(m => m.Identifier.Text);
        string sig = $"{node.Identifier} {{ {string.Join(", ", memberNames)} }}";
        PushMember("Enum", sig, node, node.Modifiers, node.AttributeLists);
        _stack.Pop(); // Don't recurse into enum members
    }

    // Phase 2.4: Constructors
    public override void VisitConstructorDeclaration(ConstructorDeclarationSyntax node)
    {
        if (!IsPublicOrInternal(node.Modifiers)) return;
        
        string sig = $"{node.Identifier}{node.ParameterList}";
        PushMember("Constructor", sig, node, node.Modifiers, node.AttributeLists);
        _stack.Pop();
    }

    public override void VisitMethodDeclaration(MethodDeclarationSyntax node)
    {
        if (!IsPublicOrInternal(node.Modifiers)) return;
        
        string sig = $"{node.ReturnType} {node.Identifier}{node.ParameterList}";
        PushMember("Method", sig, node, node.Modifiers, node.AttributeLists);
        _stack.Pop();
    }

    public override void VisitPropertyDeclaration(PropertyDeclarationSyntax node)
    {
        if (!IsPublicOrInternal(node.Modifiers)) return;
        
        string sig = $"{node.Type} {node.Identifier}";
        PushMember("Property", sig, node, node.Modifiers, node.AttributeLists);
        _stack.Pop();
    }
}
