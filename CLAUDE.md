# Claude Code — windsurf-mcp

## What This Is
MCP server + Windsurf extension for real-time IDE collaboration between Claude Code and the editor.

## Architecture
```
Claude Code CLI ──(stdio)──▶ MCP Server (Node) ──(HTTP:7749)──▶ Windsurf Extension ──▶ VS Code API
```

## Two Pieces
1. **`extension/`** — VS Code/Windsurf extension. Runs HTTP bridge on port 7749 (configurable). Exposes editor state, buffer ops, diagnostics, symbols, completions, diff preview.
2. **`mcp-server/`** — stdio MCP server (18 tools). Claude Code calls this; it forwards to the extension via HTTP.

## Build
```bash
cd extension && npm install && npm run compile && npm run package
cd ../mcp-server && npm install
```

## Install
```bash
# Extension
/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf --install-extension extension/windsurf-mcp-bridge-0.1.0.vsix

# MCP server (already registered)
claude mcp add windsurf --scope user -- node /Users/r4vager/src/windsurf-mcp/mcp-server/index.js
```

## Tools (18)
editor_state, open_files, read_buffer, edit_buffer, replace_in_buffer,
open_file, save_file, get_diagnostics, get_symbols, go_to_definition,
find_references, rename_symbol, run_in_terminal, push_completions,
diff_preview, diff_apply, notify, hover_info

## Key Port
Default bridge port: 7749 (configurable via `windsurf-mcp.port` in Windsurf settings)
