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

const VERSION = "1.0.0";
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
  {
    name: "poll_events",
    description:
      "Poll editor events — file opens/closes, cursor moves, selections, saves, diagnostic changes, scrolling. Use 'since' timestamp for incremental polling.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "number", description: "Unix ms timestamp — only return events after this time" },
        limit: { type: "number", description: "Max events to return (default: 50)" },
      },
    },
  },
  {
    name: "search_text",
    description:
      "Search for text across all files in the workspace. Like grep but uses the editor's file index.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for" },
        include: { type: "string", description: "Glob pattern for files to include (default: **/*)" },
        exclude: { type: "string", description: "Glob pattern for files to exclude (default: **/node_modules/**)" },
        maxResults: { type: "number", description: "Max results (default: 50)" },
      },
      required: ["query"],
    },
  },
  {
    name: "search_symbols",
    description:
      "Search for symbols (functions, classes, variables) across the entire workspace by name.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Symbol name to search for" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_code_actions",
    description:
      "Get available code actions (quick fixes, refactors) at a position or range. Shows what the language server can auto-fix.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        startLine: { type: "number", description: "Start line" },
        startChar: { type: "number" },
        endLine: { type: "number" },
        endChar: { type: "number" },
      },
      required: ["path", "startLine"],
    },
  },
  {
    name: "apply_code_action",
    description:
      "Apply a specific code action by title. First use get_code_actions to see what's available, then apply by title.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        startLine: { type: "number" },
        startChar: { type: "number" },
        endLine: { type: "number" },
        endChar: { type: "number" },
        title: { type: "string", description: "Exact title of the code action to apply" },
      },
      required: ["path", "startLine", "title"],
    },
  },
  {
    name: "set_decorations",
    description:
      "Add inline annotations/decorations to code. Shows text after/before lines, highlights, hover messages. Use for code review comments, type hints, etc.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Unique ID for this decoration set (use to update/clear later)" },
        path: { type: "string", description: "File path" },
        decorations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              startLine: { type: "number" },
              startChar: { type: "number" },
              endLine: { type: "number" },
              endChar: { type: "number" },
              after: { type: "string", description: "Text to show after the line" },
              before: { type: "string", description: "Text to show before" },
              color: { type: "string", description: "Text color (CSS)" },
              backgroundColor: { type: "string", description: "Background color (CSS)" },
              hoverMessage: { type: "string", description: "Markdown shown on hover" },
            },
            required: ["startLine"],
          },
        },
      },
      required: ["id", "path", "decorations"],
    },
  },
  {
    name: "clear_decorations",
    description: "Remove decorations by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Decoration set ID to clear" },
      },
      required: ["id"],
    },
  },
  {
    name: "create_file",
    description: "Create a new file with content and open it in the editor.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path" },
        content: { type: "string", description: "File content (default: empty)" },
      },
      required: ["path"],
    },
  },
  {
    name: "delete_file",
    description: "Delete a file from the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path" },
      },
      required: ["path"],
    },
  },
  {
    name: "rename_file",
    description: "Rename/move a file. Updates imports if the language server supports it.",
    inputSchema: {
      type: "object",
      properties: {
        oldPath: { type: "string", description: "Current file path" },
        newPath: { type: "string", description: "New file path" },
      },
      required: ["oldPath", "newPath"],
    },
  },
  {
    name: "batch_edit",
    description:
      "Apply edits across multiple files in a single atomic operation. Each file can have multiple find/replace or range edits.",
    inputSchema: {
      type: "object",
      properties: {
        operations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              edits: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    find: { type: "string" },
                    replace: { type: "string" },
                    all: { type: "boolean" },
                    startLine: { type: "number" },
                    startChar: { type: "number" },
                    endLine: { type: "number" },
                    endChar: { type: "number" },
                    text: { type: "string" },
                  },
                },
              },
            },
            required: ["path", "edits"],
          },
        },
      },
      required: ["operations"],
    },
  },
  {
    name: "set_selection",
    description: "Set the cursor position or selection in the editor. Scrolls to reveal.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (optional, uses active editor)" },
        startLine: { type: "number" },
        startChar: { type: "number" },
        endLine: { type: "number" },
        endChar: { type: "number" },
      },
      required: ["startLine"],
    },
  },
  {
    name: "fold_code",
    description: "Fold or unfold code regions at specified lines.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        lines: { type: "array", items: { type: "number" }, description: "Line numbers to fold" },
        unfold: { type: "boolean", description: "Unfold instead of fold (default: false)" },
      },
      required: ["path", "lines"],
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
  poll_events: (args) => args.since ? ["POST", "/api/events"] : ["GET", "/api/events"],
  search_text: ["POST", "/api/search/text"],
  search_symbols: ["POST", "/api/search/symbols"],
  get_code_actions: ["POST", "/api/codeactions"],
  apply_code_action: ["POST", "/api/codeactions/apply"],
  set_decorations: ["POST", "/api/decorations/set"],
  clear_decorations: ["POST", "/api/decorations/clear"],
  create_file: ["POST", "/api/files/create"],
  delete_file: ["POST", "/api/files/delete"],
  rename_file: ["POST", "/api/files/rename"],
  batch_edit: ["POST", "/api/batch/edit"],
  set_selection: ["POST", "/api/selection/set"],
  fold_code: ["POST", "/api/fold"],
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

  // Version
  if (process.argv.includes("--version")) {
    console.log(`windsurf-mcp v${VERSION}`);
    return;
  }

  // Update check
  if (process.argv.includes("--update-check")) {
    try {
      const latest = await new Promise((resolve, reject) => {
        http.get("http://registry.npmjs.org/windsurf-mcp/latest", (res) => {
          let data = "";
          res.on("data", (c) => data += c);
          res.on("end", () => {
            try { resolve(JSON.parse(data).version); }
            catch { resolve(null); }
          });
        }).on("error", () => resolve(null));
      });
      if (latest && latest !== VERSION) {
        console.log(`Update available: v${VERSION} → v${latest}`);
        console.log("Run: npm update -g windsurf-mcp");
      } else {
        console.log(`windsurf-mcp v${VERSION} — up to date`);
      }
    } catch {
      console.log(`windsurf-mcp v${VERSION}`);
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
