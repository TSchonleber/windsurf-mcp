# windsurf-mcp

MCP server + Windsurf/VS Code extension for real-time IDE collaboration with Claude Code.

## Architecture

```
Claude Code CLI ──(stdio)──▶ MCP Server ──(HTTP)──▶ Windsurf Extension ──▶ VS Code API
```

Two pieces:
1. **Extension** (`extension/`) — Windsurf/VS Code extension that runs an HTTP bridge server, exposing editor state and actions.
2. **MCP Server** (`mcp-server/`) — stdio MCP server that Claude Code talks to. Translates MCP tool calls into HTTP requests to the extension.

## Features

- **Live buffer editing** — apply changes to open editor buffers in real time
- **Cursor/selection awareness** — know where the user is looking
- **Diagnostics** — pull TypeScript/ESLint/Biome errors directly from the editor
- **Symbol navigation** — go-to-definition, find references, rename
- **Custom completions** — inject context-aware tab completions
- **Diff preview** — show proposed changes as inline diffs before applying
- **Terminal integration** — run commands in Windsurf's integrated terminal

## Setup

### 1. Install the extension
```bash
cd extension && npm install && npm run package
# Install the .vsix in Windsurf
```

### 2. Register the MCP server
```bash
claude mcp add windsurf --scope user -- node /path/to/mcp-server/index.js
```

## License

MIT
