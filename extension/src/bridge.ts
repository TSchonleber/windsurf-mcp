import * as vscode from 'vscode';
import * as http from 'http';
import { URL } from 'url';
import { CompletionProvider } from './completions';
import { DiffPreview } from './diff-preview';
import { EventStream } from './events';

interface BridgeStats {
  connected: boolean;
  requestCount: number;
  lastRequest: string | null;
}

type RouteHandler = (body: any) => Promise<any>;

export class BridgeServer {
  private server: http.Server | null = null;
  private port: number;
  private context: vscode.ExtensionContext;
  private stats: BridgeStats = { connected: false, requestCount: 0, lastRequest: null };
  private completionProvider: CompletionProvider | null = null;
  private diffPreview: DiffPreview | null = null;
  private eventStream: EventStream;
  private decorationTypes: Map<string, vscode.TextEditorDecorationType> = new Map();
  private routes: Map<string, RouteHandler> = new Map();

  constructor(port: number, context: vscode.ExtensionContext) {
    this.port = port;
    this.context = context;
    this.eventStream = new EventStream();
    this.registerRoutes();
  }

  setCompletionProvider(provider: CompletionProvider) {
    this.completionProvider = provider;
  }

  setDiffPreview(preview: DiffPreview) {
    this.diffPreview = preview;
  }

  getStats(): BridgeStats {
    return { ...this.stats };
  }

  private registerRoutes() {
    // --- Editor State ---
    this.routes.set('GET /api/state', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return { active: false };
      return {
        active: true,
        file: editor.document.uri.fsPath,
        languageId: editor.document.languageId,
        lineCount: editor.document.lineCount,
        isDirty: editor.document.isDirty,
        selection: {
          start: { line: editor.selection.start.line, character: editor.selection.start.character },
          end: { line: editor.selection.end.line, character: editor.selection.end.character },
          isEmpty: editor.selection.isEmpty,
          text: editor.document.getText(editor.selection)
        },
        visibleRange: {
          start: editor.visibleRanges[0]?.start.line ?? 0,
          end: editor.visibleRanges[0]?.end.line ?? 0
        },
        cursor: { line: editor.selection.active.line, character: editor.selection.active.character }
      };
    });

    // --- Open Files ---
    this.routes.set('GET /api/files', async () => {
      const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
      return {
        openFiles: tabs.map(t => ({
          label: t.label,
          isActive: t.isActive,
          isDirty: t.isDirty,
          uri: (t.input as any)?.uri?.fsPath ?? null
        })),
        workspaceFolders: vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? []
      };
    });

    // --- Read File Buffer ---
    this.routes.set('POST /api/buffer/read', async (body) => {
      const { path, startLine, endLine } = body;
      const uri = vscode.Uri.file(path);
      const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === path)
        || await vscode.workspace.openTextDocument(uri);
      const start = startLine ?? 0;
      const end = endLine ?? doc.lineCount;
      const range = new vscode.Range(start, 0, Math.min(end, doc.lineCount), 0);
      return {
        content: doc.getText(range),
        lineCount: doc.lineCount,
        languageId: doc.languageId,
        isDirty: doc.isDirty
      };
    });

    // --- Edit File Buffer (Live) ---
    this.routes.set('POST /api/buffer/edit', async (body) => {
      const { path, edits } = body;
      // edits: [{ startLine, startChar, endLine, endChar, text }]
      const uri = vscode.Uri.file(path);
      const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === path)
        || await vscode.workspace.openTextDocument(uri);
      
      // Show the file so user sees the edit happen
      await vscode.window.showTextDocument(doc, { preview: false });

      const wsEdit = new vscode.WorkspaceEdit();
      for (const edit of edits) {
        const range = new vscode.Range(
          edit.startLine, edit.startChar ?? 0,
          edit.endLine, edit.endChar ?? doc.lineAt(Math.min(edit.endLine, doc.lineCount - 1)).text.length
        );
        wsEdit.replace(uri, range, edit.text);
      }
      const success = await vscode.workspace.applyEdit(wsEdit);
      return { success, path, editCount: edits.length };
    });

    // --- Replace in Buffer (find/replace) ---
    this.routes.set('POST /api/buffer/replace', async (body) => {
      const { path, find, replace, all } = body;
      const uri = vscode.Uri.file(path);
      const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === path)
        || await vscode.workspace.openTextDocument(uri);
      
      await vscode.window.showTextDocument(doc, { preview: false });

      const text = doc.getText();
      const wsEdit = new vscode.WorkspaceEdit();

      if (all) {
        let idx = 0;
        let count = 0;
        while ((idx = text.indexOf(find, idx)) !== -1) {
          const startPos = doc.positionAt(idx);
          const endPos = doc.positionAt(idx + find.length);
          wsEdit.replace(uri, new vscode.Range(startPos, endPos), replace);
          idx += find.length;
          count++;
        }
        const success = await vscode.workspace.applyEdit(wsEdit);
        return { success, replacements: count };
      } else {
        const idx = text.indexOf(find);
        if (idx === -1) return { success: false, error: 'Pattern not found' };
        const startPos = doc.positionAt(idx);
        const endPos = doc.positionAt(idx + find.length);
        wsEdit.replace(uri, new vscode.Range(startPos, endPos), replace);
        const success = await vscode.workspace.applyEdit(wsEdit);
        return { success, replacements: 1 };
      }
    });

    // --- Open File ---
    this.routes.set('POST /api/file/open', async (body) => {
      const { path, line, character, preview } = body;
      const uri = vscode.Uri.file(path);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: preview ?? false });
      if (line !== undefined) {
        const pos = new vscode.Position(line, character ?? 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
      return { success: true, path: uri.fsPath };
    });

    // --- Save File ---
    this.routes.set('POST /api/file/save', async (body) => {
      const { path } = body;
      if (path) {
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === path);
        if (doc) {
          await doc.save();
          return { success: true, path };
        }
        return { success: false, error: 'File not open in editor' };
      }
      // Save active
      await vscode.commands.executeCommand('workbench.action.files.save');
      return { success: true };
    });

    // --- Diagnostics ---
    this.routes.set('GET /api/diagnostics', async () => {
      const allDiags: any[] = [];
      for (const [uri, diags] of vscode.languages.getDiagnostics()) {
        for (const d of diags) {
          allDiags.push({
            file: uri.fsPath,
            severity: vscode.DiagnosticSeverity[d.severity],
            message: d.message,
            source: d.source,
            range: {
              startLine: d.range.start.line,
              startChar: d.range.start.character,
              endLine: d.range.end.line,
              endChar: d.range.end.character
            },
            code: typeof d.code === 'object' ? d.code.value : d.code
          });
        }
      }
      return { diagnostics: allDiags, count: allDiags.length };
    });

    this.routes.set('POST /api/diagnostics', async (body) => {
      const { path, severities } = body;
      const uri = vscode.Uri.file(path);
      const diags = vscode.languages.getDiagnostics(uri);
      const filtered = severities
        ? diags.filter(d => severities.includes(vscode.DiagnosticSeverity[d.severity]))
        : diags;
      return {
        file: path,
        diagnostics: filtered.map(d => ({
          severity: vscode.DiagnosticSeverity[d.severity],
          message: d.message,
          source: d.source,
          range: {
            startLine: d.range.start.line,
            startChar: d.range.start.character,
            endLine: d.range.end.line,
            endChar: d.range.end.character
          },
          code: typeof d.code === 'object' ? d.code.value : d.code
        })),
        count: filtered.length
      };
    });

    // --- Symbols ---
    this.routes.set('POST /api/symbols', async (body) => {
      const { path } = body;
      const uri = vscode.Uri.file(path);
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider', uri
      );
      const flatten = (syms: vscode.DocumentSymbol[], depth = 0): any[] => {
        const result: any[] = [];
        for (const s of syms ?? []) {
          result.push({
            name: s.name,
            kind: vscode.SymbolKind[s.kind],
            range: { startLine: s.range.start.line, endLine: s.range.end.line },
            detail: s.detail,
            depth
          });
          result.push(...flatten(s.children, depth + 1));
        }
        return result;
      };
      return { symbols: flatten(symbols ?? []) };
    });

    // --- Go to Definition ---
    this.routes.set('POST /api/definition', async (body) => {
      const { path, line, character } = body;
      const uri = vscode.Uri.file(path);
      const pos = new vscode.Position(line, character);
      const locations = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        'vscode.executeDefinitionProvider', uri, pos
      );
      return {
        definitions: (locations ?? []).map(loc => {
          if ('targetUri' in loc) {
            return { path: loc.targetUri.fsPath, line: loc.targetRange.start.line, character: loc.targetRange.start.character };
          }
          return { path: loc.uri.fsPath, line: loc.range.start.line, character: loc.range.start.character };
        })
      };
    });

    // --- Find References ---
    this.routes.set('POST /api/references', async (body) => {
      const { path, line, character } = body;
      const uri = vscode.Uri.file(path);
      const pos = new vscode.Position(line, character);
      const locations = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider', uri, pos
      );
      return {
        references: (locations ?? []).map(loc => ({
          path: loc.uri.fsPath,
          line: loc.range.start.line,
          character: loc.range.start.character
        }))
      };
    });

    // --- Rename Symbol ---
    this.routes.set('POST /api/rename', async (body) => {
      const { path, line, character, newName } = body;
      const uri = vscode.Uri.file(path);
      const pos = new vscode.Position(line, character);
      const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
        'vscode.executeDocumentRenameProvider', uri, pos, newName
      );
      if (edit) {
        const success = await vscode.workspace.applyEdit(edit);
        return { success, newName };
      }
      return { success: false, error: 'Rename not available at this position' };
    });

    // --- Terminal ---
    this.routes.set('POST /api/terminal/run', async (body) => {
      const { command, name } = body;
      const terminal = vscode.window.createTerminal(name ?? 'MCP');
      terminal.show();
      terminal.sendText(command);
      return { success: true, name: terminal.name };
    });

    // --- Custom Completions (push from MCP) ---
    this.routes.set('POST /api/completions/push', async (body) => {
      const { items } = body;
      // items: [{ label, insertText, detail, documentation, kind }]
      if (this.completionProvider) {
        this.completionProvider.setItems(items);
        return { success: true, count: items.length };
      }
      return { success: false, error: 'Completion provider not enabled' };
    });

    // --- Diff Preview ---
    this.routes.set('POST /api/diff/preview', async (body) => {
      const { path, newContent, title } = body;
      if (this.diffPreview) {
        await this.diffPreview.show(path, newContent, title);
        return { success: true };
      }
      return { success: false, error: 'Diff preview not available' };
    });

    this.routes.set('POST /api/diff/apply', async (body) => {
      const { path } = body;
      if (this.diffPreview) {
        const success = await this.diffPreview.apply(path);
        return { success };
      }
      return { success: false };
    });

    // --- Notification ---
    this.routes.set('POST /api/notify', async (body) => {
      const { message, type } = body;
      switch (type) {
        case 'error': vscode.window.showErrorMessage(message); break;
        case 'warning': vscode.window.showWarningMessage(message); break;
        default: vscode.window.showInformationMessage(message);
      }
      return { success: true };
    });

    // --- Hover Info ---
    this.routes.set('POST /api/hover', async (body) => {
      const { path, line, character } = body;
      const uri = vscode.Uri.file(path);
      const pos = new vscode.Position(line, character);
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider', uri, pos
      );
      const contents = (hovers ?? []).flatMap(h =>
        h.contents.map(c => typeof c === 'string' ? c : (c as vscode.MarkdownString).value)
      );
      return { hover: contents };
    });

    // --- Events (polling) ---
    this.routes.set('GET /api/events', async () => {
      return { events: this.eventStream.getRecent(50) };
    });

    this.routes.set('POST /api/events', async (body) => {
      const { since, limit } = body;
      const events = since
        ? this.eventStream.getEventsSince(since)
        : this.eventStream.getRecent(limit ?? 50);
      return { events, count: events.length };
    });

    // --- Workspace Search ---
    this.routes.set('POST /api/search/text', async (body) => {
      const { query, include, exclude, maxResults } = body;
      const results: any[] = [];

      const includeGlob = include ?? '**/*';
      const excludeGlob = exclude ?? '**/node_modules/**';
      const files = await vscode.workspace.findFiles(includeGlob, excludeGlob, maxResults ?? 50);

      for (const fileUri of files.slice(0, 20)) {
        try {
          const doc = await vscode.workspace.openTextDocument(fileUri);
          const text = doc.getText();
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const idx = lines[i].indexOf(query);
            if (idx !== -1) {
              results.push({
                file: fileUri.fsPath,
                line: i,
                column: idx,
                text: lines[i].trim(),
                preview: lines[i].substring(Math.max(0, idx - 30), idx + query.length + 30).trim(),
              });
              if (results.length >= (maxResults ?? 50)) break;
            }
          }
        } catch {}
        if (results.length >= (maxResults ?? 50)) break;
      }
      return { results, count: results.length, query };
    });

    this.routes.set('POST /api/search/symbols', async (body) => {
      const { query } = body;
      const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider', query
      );
      return {
        symbols: (symbols ?? []).slice(0, 50).map(s => ({
          name: s.name,
          kind: vscode.SymbolKind[s.kind],
          file: s.location.uri.fsPath,
          line: s.location.range.start.line,
          containerName: s.containerName,
        }))
      };
    });

    // --- Code Actions (Quick Fixes / Refactors) ---
    this.routes.set('POST /api/codeactions', async (body) => {
      const { path, startLine, startChar, endLine, endChar } = body;
      const uri = vscode.Uri.file(path);
      const range = new vscode.Range(
        startLine ?? 0, startChar ?? 0,
        endLine ?? startLine ?? 0, endChar ?? 999
      );
      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        'vscode.executeCodeActionProvider', uri, range
      );
      return {
        actions: (actions ?? []).map(a => ({
          title: a.title,
          kind: a.kind?.value,
          isPreferred: a.isPreferred,
          diagnostics: a.diagnostics?.map(d => d.message),
        }))
      };
    });

    this.routes.set('POST /api/codeactions/apply', async (body) => {
      const { path, startLine, startChar, endLine, endChar, title } = body;
      const uri = vscode.Uri.file(path);
      const range = new vscode.Range(
        startLine ?? 0, startChar ?? 0,
        endLine ?? startLine ?? 0, endChar ?? 999
      );
      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        'vscode.executeCodeActionProvider', uri, range
      );
      const action = (actions ?? []).find(a => a.title === title);
      if (!action) return { success: false, error: `No action found: "${title}"` };

      if (action.edit) {
        await vscode.workspace.applyEdit(action.edit);
      }
      if (action.command) {
        await vscode.commands.executeCommand(action.command.command, ...(action.command.arguments ?? []));
      }
      return { success: true, title: action.title };
    });

    // --- Inline Decorations ---
    this.routes.set('POST /api/decorations/set', async (body) => {
      const { id, path, decorations } = body;
      // decorations: [{ startLine, startChar, endLine, endChar, after?, before?, color?, backgroundColor? }]
      const uri = vscode.Uri.file(path);

      // Remove old decoration type if exists
      const oldType = this.decorationTypes.get(id);
      if (oldType) oldType.dispose();

      // Build decoration render options from first decoration as template
      const first = decorations[0] ?? {};
      const decorationType = vscode.window.createTextEditorDecorationType({
        after: first.after ? {
          contentText: first.after,
          color: first.color ?? '#888888',
          fontStyle: 'italic',
          margin: '0 0 0 1em',
        } : undefined,
        before: first.before ? {
          contentText: first.before,
          color: first.color ?? '#888888',
        } : undefined,
        backgroundColor: first.backgroundColor,
        border: first.border,
        outline: first.outline,
      });

      this.decorationTypes.set(id, decorationType);

      // Apply to the editor
      const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === path);
      if (editor) {
        const ranges = decorations.map((d: any) => {
          const range = new vscode.Range(
            d.startLine, d.startChar ?? 0,
            d.endLine ?? d.startLine, d.endChar ?? 999
          );
          const opts: vscode.DecorationOptions = { range };
          // Per-decoration overrides
          if (d.after && d.after !== first.after) {
            opts.renderOptions = {
              after: { contentText: d.after, color: d.color ?? '#888888', fontStyle: 'italic', margin: '0 0 0 1em' }
            };
          }
          if (d.hoverMessage) {
            opts.hoverMessage = new vscode.MarkdownString(d.hoverMessage);
          }
          return opts;
        });
        editor.setDecorations(decorationType, ranges);
        return { success: true, id, count: ranges.length };
      }
      return { success: false, error: 'File not visible in editor' };
    });

    this.routes.set('POST /api/decorations/clear', async (body) => {
      const { id } = body;
      const decorationType = this.decorationTypes.get(id);
      if (decorationType) {
        decorationType.dispose();
        this.decorationTypes.delete(id);
        return { success: true, id };
      }
      return { success: false, error: `No decoration with id: ${id}` };
    });

    // --- Multi-File Operations ---
    this.routes.set('POST /api/files/create', async (body) => {
      const { path: filePath, content } = body;
      const uri = vscode.Uri.file(filePath);
      const encoder = new TextEncoder();
      await vscode.workspace.fs.writeFile(uri, encoder.encode(content ?? ''));
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
      return { success: true, path: filePath };
    });

    this.routes.set('POST /api/files/delete', async (body) => {
      const { path: filePath } = body;
      const uri = vscode.Uri.file(filePath);
      await vscode.workspace.fs.delete(uri);
      return { success: true, path: filePath };
    });

    this.routes.set('POST /api/files/rename', async (body) => {
      const { oldPath, newPath } = body;
      const oldUri = vscode.Uri.file(oldPath);
      const newUri = vscode.Uri.file(newPath);
      const edit = new vscode.WorkspaceEdit();
      edit.renameFile(oldUri, newUri);
      const success = await vscode.workspace.applyEdit(edit);
      return { success, oldPath, newPath };
    });

    this.routes.set('POST /api/batch/edit', async (body) => {
      const { operations } = body;
      // operations: [{ path, edits: [{ find, replace, all? }] }]
      const wsEdit = new vscode.WorkspaceEdit();
      let totalEdits = 0;

      for (const op of operations) {
        const uri = vscode.Uri.file(op.path);
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === op.path)
          || await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();

        for (const edit of op.edits) {
          if (edit.find !== undefined) {
            // Find/replace mode
            let idx = 0;
            while ((idx = text.indexOf(edit.find, idx)) !== -1) {
              const startPos = doc.positionAt(idx);
              const endPos = doc.positionAt(idx + edit.find.length);
              wsEdit.replace(uri, new vscode.Range(startPos, endPos), edit.replace);
              totalEdits++;
              if (!edit.all) break;
              idx += edit.find.length;
            }
          } else if (edit.startLine !== undefined) {
            // Range mode
            const range = new vscode.Range(
              edit.startLine, edit.startChar ?? 0,
              edit.endLine, edit.endChar ?? doc.lineAt(Math.min(edit.endLine, doc.lineCount - 1)).text.length
            );
            wsEdit.replace(uri, range, edit.text);
            totalEdits++;
          }
        }
      }

      const success = await vscode.workspace.applyEdit(wsEdit);
      return { success, totalEdits, fileCount: operations.length };
    });

    // --- Selection manipulation ---
    this.routes.set('POST /api/selection/set', async (body) => {
      const { path, startLine, startChar, endLine, endChar } = body;
      const editor = path
        ? vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === path)
        : vscode.window.activeTextEditor;
      if (!editor) return { success: false, error: 'No matching editor' };

      const sel = new vscode.Selection(
        startLine ?? 0, startChar ?? 0,
        endLine ?? startLine ?? 0, endChar ?? 0
      );
      editor.selection = sel;
      editor.revealRange(sel, vscode.TextEditorRevealType.InCenter);
      return { success: true };
    });

    // --- Fold/Unfold ---
    this.routes.set('POST /api/fold', async (body) => {
      const { path, lines, unfold } = body;
      const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === path);
      if (!editor) return { success: false, error: 'File not visible' };

      // Set selection to lines to fold
      const selections = (lines as number[]).map(l => new vscode.Selection(l, 0, l, 0));
      editor.selections = selections;
      const cmd = unfold ? 'editor.unfold' : 'editor.fold';
      await vscode.commands.executeCommand(cmd);
      return { success: true, action: unfold ? 'unfold' : 'fold', lines };
    });

    // --- Shutdown (for EADDRINUSE recovery) ---
    this.routes.set('POST /api/shutdown', async () => {
      setTimeout(() => this.stop(), 100);
      return { status: 'shutting_down' };
    });

    // --- Health ---
    this.routes.set('GET /api/health', async () => {
      return {
        status: 'ok',
        version: '0.2.0',
        uptime: process.uptime(),
        workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
        toolCount: this.routes.size,
        eventCount: this.eventStream.getRecent(1).length > 0 ? 'streaming' : 'idle',
      };
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        this.stats.requestCount++;
        this.stats.lastRequest = new Date().toISOString();

        // CORS
        res.setHeader('Access-Control-Allow-Origin', '127.0.0.1');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        // SSE endpoint
        if (req.url === '/api/events/stream' && req.method === 'GET') {
          this.eventStream.handleSSE(res);
          return;
        }

        const routeKey = `${req.method} ${req.url?.split('?')[0]}`;
        const handler = this.routes.get(routeKey);

        if (!handler) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: `Unknown route: ${routeKey}`, routes: Array.from(this.routes.keys()) }));
          return;
        }

        try {
          let body: any = {};
          if (req.method === 'POST') {
            body = await this.readBody(req);
          }
          const result = await handler(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err: any) {
          console.error(`[windsurf-mcp] Error in ${routeKey}:`, err);
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }
      });

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.log(`[windsurf-mcp] Port ${this.port} in use, sending shutdown to old instance...`);
          // Ask the old instance to die via its own health endpoint
          const killReq = http.request({ hostname: '127.0.0.1', port: this.port, path: '/api/shutdown', method: 'POST', timeout: 2000 }, () => {
            // Retry after old instance shuts down
            setTimeout(() => {
              this.server = http.createServer(this.server!.listeners('request')[0] as any);
              this.server!.listen(this.port, '127.0.0.1', () => {
                this.stats.connected = true;
                resolve();
              });
              this.server!.on('error', (retryErr) => {
                this.stats.connected = false;
                reject(retryErr);
              });
            }, 500);
          });
          killReq.on('error', () => {
            // Old instance didn't respond, just retry after delay
            setTimeout(() => {
              this.server = http.createServer(this.server!.listeners('request')[0] as any);
              this.server!.listen(this.port, '127.0.0.1', () => {
                this.stats.connected = true;
                resolve();
              });
              this.server!.on('error', (retryErr) => {
                this.stats.connected = false;
                reject(retryErr);
              });
            }, 1500);
          });
          killReq.end();
        } else {
          this.stats.connected = false;
          reject(err);
        }
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        this.stats.connected = true;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.eventStream.dispose();
    for (const dt of this.decorationTypes.values()) dt.dispose();
    this.decorationTypes.clear();
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.stats.connected = false;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private readBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => data += chunk);
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          reject(new Error('Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }
}
