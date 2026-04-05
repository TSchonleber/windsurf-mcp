# windsurf-mcp

Real-time IDE collaboration between Claude Code and your editor.

Claude Code gets 33 tools to see what you're doing, edit your buffers live, pull diagnostics, push completions, annotate your code, and more. Plus inline `@claude` chat — talk to Claude right in your source files.

Works with **Windsurf**, **VS Code**, and **Cursor**.

## Quick Start

### 1. Install the MCP server

```bash
claude mcp add windsurf -- npx windsurf-mcp
```

That's it. Claude Code now has IDE tools available.

### 2. Install the extension

Download the `.vsix` from [Releases](https://github.com/TSchonleber/windsurf-mcp/releases), then:

```bash
# Windsurf
windsurf --install-extension windsurf-mcp-bridge-0.2.0.vsix

# VS Code
code --install-extension windsurf-mcp-bridge-0.2.0.vsix

# Cursor
cursor --install-extension windsurf-mcp-bridge-0.2.0.vsix
```

The extension runs an HTTP bridge on `127.0.0.1:7749` that the MCP server talks to.

## Architecture

```
Claude Code CLI ──(stdio)──▶ MCP Server ──(HTTP:7749)──▶ Extension ──▶ VS Code API
```

The MCP server is a thin translator. The extension does the real work — it has full access to the editor API.

## Features

### 🔧 33 MCP Tools

Claude Code can control your editor:

| Category | Tools | What they do |
|----------|-------|-------------|
| **Awareness** | `editor_state`, `open_files`, `hover_info` | See what you're looking at, cursor position, selection |
| **Live Editing** | `edit_buffer`, `replace_in_buffer`, `read_buffer` | Edit open files in real-time — you watch it happen |
| **Files** | `open_file`, `save_file`, `create_file`, `delete_file`, `rename_file` | Full file management |
| **Diagnostics** | `get_diagnostics` | Pull TypeScript/ESLint/Biome errors without running linters |
| **Code Intel** | `get_symbols`, `go_to_definition`, `find_references`, `hover_info` | Language server features |
| **Refactoring** | `rename_symbol`, `get_code_actions`, `apply_code_action` | Multi-file rename, quick fixes |
| **Search** | `search_text`, `search_symbols` | Workspace-wide text and symbol search |
| **Batch Ops** | `batch_edit` | Atomic edits across multiple files |
| **Completions** | `push_completions` | Inject custom tab completions |
| **Diff Preview** | `diff_preview`, `diff_apply` | Show proposed changes as a diff before applying |
| **Decorations** | `set_decorations`, `clear_decorations` | Inline annotations with colors and hover messages |
| **Events** | `poll_events` | Real-time feed of editor activity |
| **Navigation** | `set_selection`, `fold_code` | Control cursor, fold/unfold code |
| **Terminal** | `run_in_terminal` | Run commands in the IDE's integrated terminal |
| **Notifications** | `notify` | Show messages in the IDE |

### 💬 Inline @claude Chat

Talk to Claude directly in your source files:

```typescript
// @claude what does this function do?
// 🤖 It parses the JWT token and extracts the user ID from the payload.

// @claude this is broken when the input is null
// and the error message is wrong
// also add a retry
/* 🤖 claude:
   Here's the fix with null handling and retry:
   ...code appears here...
*/
```

- Type `@claude` or `// @claude` — both work
- Multi-line: keep typing on subsequent lines, it collects everything
- 5-second debounce after you stop typing
- Streams response tokens in real-time
- Uses your existing Claude Code OAuth — no API keys needed
- Status bar shows `@claude ready` / `@claude thinking...`

### ✨ Smart Completions

If you have [brainctl](https://github.com/TSchonleber/brainctl) (agent memory system), completions auto-populate from:

- Project conventions
- Past decisions and rationale
- Language-specific lessons
- Current diagnostic errors

Completions show a ✨ badge and refresh when you switch files.

## Configuration

In your editor settings (`Cmd+,`):

| Setting | Default | Description |
|---------|---------|-------------|
| `windsurf-mcp.port` | `7749` | Bridge server port |
| `windsurf-mcp.enableCompletions` | `true` | Enable tab completions |
| `windsurf-mcp.claudePath` | auto-detected | Path to `claude` CLI |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `WINDSURF_MCP_PORT` | Override bridge port for the MCP server |

## CLI Flags

```bash
npx windsurf-mcp                  # Start MCP server (stdio)
npx windsurf-mcp --list-tools     # Show all 33 tools
npx windsurf-mcp --check          # Check if extension bridge is running
npx windsurf-mcp --version        # Show version
npx windsurf-mcp --update-check   # Check for updates on npm
```

## How It Works

1. The **extension** activates when the editor starts and listens on `127.0.0.1:7749`
2. The **MCP server** connects to Claude Code via stdio and translates tool calls to HTTP requests
3. Claude Code calls tools like `edit_buffer` or `get_diagnostics`
4. The MCP server forwards to the extension's HTTP API
5. The extension executes against the VS Code API and returns results
6. **Inline chat** watches for `@claude` triggers and calls `claude -p` with streaming output

The extension also handles:
- **EADDRINUSE recovery** — if the port is busy from a stale process, it sends a shutdown signal and retries
- **Event streaming** via SSE at `/api/events/stream` or polling at `/api/events`

## Development

```bash
# Extension
cd extension
npm install
npm run compile     # TypeScript → dist/
npm run watch       # Watch mode
npm run package     # Build .vsix

# MCP Server
cd mcp-server
npm install
node index.js --list-tools
```

## License

MIT
