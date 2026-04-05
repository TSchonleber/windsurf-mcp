import * as http from 'http';

// Detects when an @claude query could benefit from editor tools,
// executes them, and returns enriched context for the LLM.

const BRIDGE_PORT = 7749;

interface ToolResult {
  toolName: string;
  data: any;
  summary: string;
}

// Pattern → tool mapping
const TOOL_PATTERNS: Array<{
  pattern: RegExp;
  tools: (match: RegExpMatchArray, filePath: string, cursorLine: number) => Array<{ endpoint: string; method: string; body?: any; name: string }>;
}> = [
  {
    // "references to X", "find references", "who uses X", "where is X used"
    pattern: /(?:references?\s+(?:to|for)|find\s+references|who\s+uses?|where\s+is\s+\w+\s+used)/i,
    tools: (_m, filePath, cursorLine) => [{
      endpoint: '/api/references',
      method: 'POST',
      body: { path: filePath, line: cursorLine, character: 0 },
      name: 'find_references',
    }],
  },
  {
    // "errors", "diagnostics", "what's broken", "what's wrong", "problems"
    pattern: /(?:errors?|diagnostics?|what'?s?\s+(?:broken|wrong)|problems?|issues?|warnings?)/i,
    tools: (_m, filePath) => [{
      endpoint: '/api/diagnostics',
      method: 'POST',
      body: { path: filePath },
      name: 'get_diagnostics',
    }],
  },
  {
    // "definition of X", "where is X defined", "go to definition"
    pattern: /(?:definition\s+(?:of|for)|where\s+is\s+\w+\s+defined|go\s+to\s+def)/i,
    tools: (_m, filePath, cursorLine) => [{
      endpoint: '/api/definition',
      method: 'POST',
      body: { path: filePath, line: cursorLine, character: 0 },
      name: 'go_to_definition',
    }],
  },
  {
    // "symbols", "outline", "functions in this file", "what's in this file"
    pattern: /(?:symbols?|outline|functions?\s+in|what'?s?\s+in\s+this\s+file|structure|overview)/i,
    tools: (_m, filePath) => [{
      endpoint: '/api/symbols',
      method: 'POST',
      body: { path: filePath },
      name: 'get_symbols',
    }],
  },
  {
    // "type of X", "what type", "hover", "type info"
    pattern: /(?:type\s+(?:of|for|info)|what\s+type|hover\s+info)/i,
    tools: (_m, filePath, cursorLine) => [{
      endpoint: '/api/hover',
      method: 'POST',
      body: { path: filePath, line: cursorLine, character: 0 },
      name: 'hover_info',
    }],
  },
  {
    // "open files", "what files are open", "tabs"
    pattern: /(?:open\s+files?|what\s+files?\s+(?:are\s+)?open|tabs?)/i,
    tools: () => [{
      endpoint: '/api/files',
      method: 'GET',
      name: 'open_files',
    }],
  },
  {
    // "search for X", "find X in", "grep X"
    pattern: /(?:search\s+(?:for|the\s+(?:codebase|project|workspace))|find\s+.+\s+in|grep)\s+['"]?(.+?)['"]?\s*$/i,
    tools: (m) => [{
      endpoint: '/api/search/text',
      method: 'POST',
      body: { query: m[1], maxResults: 20 },
      name: 'search_text',
    }],
  },
  {
    // "code actions", "quick fixes", "how to fix", "auto fix"
    pattern: /(?:code\s+actions?|quick\s+fix(?:es)?|how\s+to\s+fix|auto\s*fix|available\s+fixes)/i,
    tools: (_m, filePath, cursorLine) => [{
      endpoint: '/api/codeactions',
      method: 'POST',
      body: { path: filePath, startLine: cursorLine },
      name: 'get_code_actions',
    }],
  },
];

function bridgeRequest(method: string, path: string, body?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: '127.0.0.1',
      port: BRIDGE_PORT,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data }); }
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function summarizeResult(name: string, data: any): string {
  if (!data) return `${name}: no data`;

  switch (name) {
    case 'find_references': {
      const refs = data.references ?? [];
      if (refs.length === 0) return 'No references found.';
      const lines = refs.map((r: any) =>
        `  ${r.path.split('/').pop()}:${r.line + 1}`
      );
      return `Found ${refs.length} reference(s):\n${lines.join('\n')}`;
    }
    case 'get_diagnostics': {
      const diags = data.diagnostics ?? [];
      if (diags.length === 0) return 'No diagnostics — file is clean.';
      const lines = diags.map((d: any) =>
        `  Line ${d.range.startLine + 1}: [${d.severity}] ${d.message} (${d.source ?? 'unknown'})`
      );
      return `${diags.length} diagnostic(s):\n${lines.join('\n')}`;
    }
    case 'go_to_definition': {
      const defs = data.definitions ?? [];
      if (defs.length === 0) return 'No definition found.';
      return defs.map((d: any) =>
        `Defined at ${d.path.split('/').pop()}:${d.line + 1}`
      ).join('\n');
    }
    case 'get_symbols': {
      const syms = data.symbols ?? [];
      if (syms.length === 0) return 'No symbols found.';
      const lines = syms.map((s: any) =>
        `  ${'  '.repeat(s.depth)}${s.kind} ${s.name} (line ${s.range.startLine + 1})`
      );
      return `${syms.length} symbol(s):\n${lines.join('\n')}`;
    }
    case 'hover_info': {
      const hover = data.hover ?? [];
      return hover.length > 0 ? hover.join('\n') : 'No type info available.';
    }
    case 'open_files': {
      const files = data.openFiles ?? [];
      return files.map((f: any) =>
        `  ${f.label}${f.isDirty ? ' (modified)' : ''}${f.isActive ? ' ← active' : ''}`
      ).join('\n');
    }
    case 'search_text': {
      const results = data.results ?? [];
      if (results.length === 0) return 'No matches found.';
      const lines = results.slice(0, 15).map((r: any) =>
        `  ${r.file.split('/').pop()}:${r.line + 1}: ${r.text.trim()}`
      );
      return `${data.count} match(es):\n${lines.join('\n')}`;
    }
    case 'get_code_actions': {
      const actions = data.actions ?? [];
      if (actions.length === 0) return 'No code actions available.';
      return actions.map((a: any) =>
        `  ${a.isPreferred ? '★' : '•'} ${a.title}${a.kind ? ` (${a.kind})` : ''}`
      ).join('\n');
    }
    default:
      return JSON.stringify(data).slice(0, 500);
  }
}

export async function dispatchTools(
  question: string,
  filePath: string,
  cursorLine: number
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];

  for (const { pattern, tools } of TOOL_PATTERNS) {
    const match = question.match(pattern);
    if (!match) continue;

    const toolCalls = tools(match, filePath, cursorLine);
    for (const call of toolCalls) {
      const data = await bridgeRequest(call.method, call.endpoint, call.body);
      if (data) {
        results.push({
          toolName: call.name,
          data,
          summary: summarizeResult(call.name, data),
        });
      }
    }
  }

  return results;
}
