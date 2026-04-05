#!/usr/bin/env node

/**
 * windsurf-mcp — MCP server bridging Claude Code to the Windsurf IDE extension.
 *
 * Translates MCP tool calls into HTTP requests to the Windsurf MCP Bridge
 * extension running inside the IDE on port 7749.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import http from "http";

const BRIDGE_PORT = parseInt(process.env.WINDSURF_MCP_PORT ?? "7749", 10);
const BRIDGE_HOST = "127.0.0.1";

// --- HTTP client to extension bridge ---

function bridgeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BRIDGE_HOST,
      port: BRIDGE_PORT,
      path,
      method,
      headers: { "Content-Type": "application/json" },
      timeout: 10000,
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ raw: data });
        }
      });
    });

    req.on("error", (err) => {
      reject(new Error(`Bridge connection failed (port ${BRIDGE_PORT}): ${err.message}. Is the Windsurf extension running?`));
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Bridge request timed out"));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// --- Tool Definitions ---

const TOOLS = [
  {
    name: "editor_state",
    description:
      "Get current editor state — active file, cursor position, selection, visible range. Use to understand what the user is looking at.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "open_files",
    description:
      "List all open files/tabs in the editor and workspace folders.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_buffer",
    description:
      "Read content from an open file buffer (or open it). Gets live editor content, not disk content.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path" },
        startLine: { type: "number", description: "Start line (0-indexed, optional)" },
        endLine: { type: "number", description: "End line (exclusive, optional)" },
      },
      required: ["path"],
    },
  },
  {
    name: "edit_buffer",
    description:
      "Apply live edits to an open file buffer. The user sees changes appear in real time. Each edit specifies a range to replace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              startLine: { type: "number" },
              startChar: { type: "number" },
              endLine: { type: "number" },
              endChar: { type: "number" },
              text: { type: "string", description: "Replacement text" },
            },
            required: ["startLine", "endLine", "text"],
          },
          description: "Array of edits to apply",
        },
      },
      required: ["path", "edits"],
    },
  },
  {
    name: "replace_in_buffer",
    description:
      "Find and replace text in a file buffer. Like patch but the user sees it happen live in the editor.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path" },
        find: { type: "string", description: "Text to find" },
        replace: { type: "string", description: "Replacement text" },
        all: { type: "boolean", description: "Replace all occurrences (default: false)" },
      },
      required: ["path", "find", "replace"],
    },
  },
  {
    name: "open_file",
    description: "Open a file in the editor, optionally jumping to a specific line.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path" },
        line: { type: "number", description: "Line to jump to (0-indexed)" },
        character: { type: "number", description: "Column position" },
      },
      required: ["path"],
    },
  },
  {
    name: "save_file",
    description: "Save a file (or the active file if no path given).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (optional, saves active file if omitted)" },
      },
    },
  },
  {
    name: "get_diagnostics",
    description:
      "Get all diagnostics (errors, warnings) from the editor. Includes TypeScript, ESLint, Biome, etc. errors without running linters manually.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Filter to specific file (optional)" },
        severities: {
          type: "array",
          items: { type: "string", enum: ["Error", "Warning", "Information", "Hint"] },
          description: "Filter by severity (optional)",
        },
      },
    },
  },
  {
    name: "get_symbols",
    description:
      "Get document symbols (functions, classes, variables, etc.) for a file. Like an outline view.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path" },
      },
      required: ["path"],
    },
  },
  {
    name: "go_to_definition",
    description:
      "Find the definition of a symbol at a given position. Returns file path and line number.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File containing the symbol" },
        line: { type: "number", description: "Line number (0-indexed)" },
        character: { type: "number", description: "Column position" },
      },
      required: ["path", "line", "character"],
    },
  },
  {
    name: "find_references",
    description: "Find all references to a symbol at a given position across the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File containing the symbol" },
        line: { type: "number", description: "Line number (0-indexed)" },
        character: { type: "number", description: "Column position" },
      },
      required: ["path", "line", "character"],
    },
  },
  {
    name: "rename_symbol",
    description:
      "Rename a symbol across the entire workspace. Uses the language server for accurate multi-file rename.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File containing the symbol" },
        line: { type: "number", description: "Line number (0-indexed)" },
        character: { type: "number", description: "Column position" },
        newName: { type: "string", description: "New name for the symbol" },
      },
      required: ["path", "line", "character", "newName"],
    },
  },
  {
    name: "run_in_terminal",
    description:
      "Run a command in the Windsurf integrated terminal. Opens a new terminal tab visible to the user.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run" },
        name: { type: "string", description: "Terminal tab name (optional)" },
      },
      required: ["command"],
    },
  },
  {
    name: "push_completions",
    description:
      "Push custom tab completion items into the editor. They appear in the autocomplete dropdown with a ✨ badge.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Display label" },
              insertText: { type: "string", description: "Text to insert (supports snippet syntax)" },
              detail: { type: "string", description: "Short detail text" },
              documentation: { type: "string", description: "Markdown documentation" },
              kind: { type: "string", enum: ["text", "method", "function", "variable", "class", "snippet", "keyword", "constant"] },
            },
            required: ["label", "insertText"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "diff_preview",
    description:
      "Show proposed changes as a diff view in the editor. The user can review before accepting. Use diff_apply to apply.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to show diff for" },
        newContent: { type: "string", description: "Proposed new file content" },
        title: { type: "string", description: "Title for the diff tab" },
      },
      required: ["path", "newContent"],
    },
  },
  {
    name: "diff_apply",
    description: "Apply a previously previewed diff to the file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to apply the diff to" },
      },
      required: ["path"],
    },
  },
  {
    name: "notify",
    description: "Show a notification message in the IDE.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Notification message" },
        type: { type: "string", enum: ["info", "warning", "error"], description: "Notification type" },
      },
      required: ["message"],
    },
  },
  {
    name: "hover_info",
    description: "Get hover/type information at a position. Shows what the language server knows about a symbol.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        line: { type: "number", description: "Line number (0-indexed)" },
        character: { type: "number", description: "Column position" },
      },
      required: ["path", "line", "character"],
    },
  },
];

// --- Route mapping: tool name → HTTP method + path ---

const TOOL_ROUTES = {
  editor_state: ["GET", "/api/state"],
  open_files: ["GET", "/api/files"],
  read_buffer: ["POST", "/api/buffer/read"],
  edit_buffer: ["POST", "/api/buffer/edit"],
  replace_in_buffer: ["POST", "/api/buffer/replace"],
  open_file: ["POST", "/api/file/open"],
  save_file: ["POST", "/api/file/save"],
  get_diagnostics: (args) =>
    args.path ? ["POST", "/api/diagnostics"] : ["GET", "/api/diagnostics"],
  get_symbols: ["POST", "/api/symbols"],
  go_to_definition: ["POST", "/api/definition"],
  find_references: ["POST", "/api/references"],
  rename_symbol: ["POST", "/api/rename"],
  run_in_terminal: ["POST", "/api/terminal/run"],
  push_completions: ["POST", "/api/completions/push"],
  diff_preview: ["POST", "/api/diff/preview"],
  diff_apply: ["POST", "/api/diff/apply"],
  notify: ["POST", "/api/notify"],
  hover_info: ["POST", "/api/hover"],
};

// --- MCP Server ---

const server = new Server(
  { name: "windsurf-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const routeEntry = TOOL_ROUTES[name];
  if (!routeEntry) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
    };
  }

  const [method, path] =
    typeof routeEntry === "function" ? routeEntry(args ?? {}) : routeEntry;

  try {
    const result = await bridgeRequest(method, path, method === "POST" ? (args ?? {}) : null);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
      isError: true,
    };
  }
});

// --- Start ---

async function main() {
  if (process.argv.includes("--list-tools")) {
    for (const t of TOOLS) {
      console.log(`  ${t.name}: ${t.description.slice(0, 80)}`);
    }
    return;
  }

  // Health check
  if (process.argv.includes("--check")) {
    try {
      const result = await bridgeRequest("GET", "/api/health");
      console.log("Bridge status:", JSON.stringify(result, null, 2));
    } catch (err) {
      console.error("Bridge not reachable:", err.message);
      process.exit(1);
    }
    return;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
