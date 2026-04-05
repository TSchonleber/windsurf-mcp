import * as vscode from 'vscode';
import * as http from 'http';

/**
 * Event stream — tracks editor events and serves them via SSE or polling.
 * Claude Code can poll /api/events to know what the user is doing in real time.
 */

interface EditorEvent {
  type: string;
  timestamp: number;
  data: any;
}

export class EventStream {
  private events: EditorEvent[] = [];
  private maxEvents = 200;
  private disposables: vscode.Disposable[] = [];
  private sseClients: Set<http.ServerResponse> = new Set();

  constructor() {
    this.setupListeners();
  }

  private push(type: string, data: any) {
    const event: EditorEvent = { type, timestamp: Date.now(), data };
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }

    // Push to SSE clients
    const msg = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(msg);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  private setupListeners() {
    // Active editor changed
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.push('activeEditorChanged', {
            file: editor.document.uri.fsPath,
            languageId: editor.document.languageId,
            lineCount: editor.document.lineCount,
          });
        }
      })
    );

    // Selection/cursor changed
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => {
        const sel = e.selections[0];
        this.push('selectionChanged', {
          file: e.textEditor.document.uri.fsPath,
          cursor: { line: sel.active.line, character: sel.active.character },
          selection: sel.isEmpty ? null : {
            start: { line: sel.start.line, character: sel.start.character },
            end: { line: sel.end.line, character: sel.end.character },
            text: e.textEditor.document.getText(sel),
          },
        });
      })
    );

    // Document saved
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        this.push('fileSaved', {
          file: doc.uri.fsPath,
          languageId: doc.languageId,
        });
      })
    );

    // Document changed (content edits)
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length === 0) return;
        // Throttle: only emit if it's the active editor
        const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
        if (e.document.uri.fsPath !== activeFile) return;

        this.push('documentChanged', {
          file: e.document.uri.fsPath,
          changeCount: e.contentChanges.length,
          changes: e.contentChanges.slice(0, 5).map(c => ({
            range: {
              startLine: c.range.start.line,
              startChar: c.range.start.character,
              endLine: c.range.end.line,
              endChar: c.range.end.character,
            },
            text: c.text.length > 200 ? c.text.slice(0, 200) + '...' : c.text,
            rangeLength: c.rangeLength,
          })),
        });
      })
    );

    // Document opened
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => {
        if (doc.uri.scheme !== 'file') return;
        this.push('fileOpened', {
          file: doc.uri.fsPath,
          languageId: doc.languageId,
          lineCount: doc.lineCount,
        });
      })
    );

    // Document closed
    this.disposables.push(
      vscode.workspace.onDidCloseTextDocument((doc) => {
        if (doc.uri.scheme !== 'file') return;
        this.push('fileClosed', { file: doc.uri.fsPath });
      })
    );

    // Diagnostics changed
    this.disposables.push(
      vscode.languages.onDidChangeDiagnostics((e) => {
        for (const uri of e.uris) {
          const diags = vscode.languages.getDiagnostics(uri);
          const errors = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
          const warnings = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Warning).length;
          this.push('diagnosticsChanged', {
            file: uri.fsPath,
            errors,
            warnings,
            total: diags.length,
          });
        }
      })
    );

    // Terminal opened/closed
    this.disposables.push(
      vscode.window.onDidOpenTerminal((t) => {
        this.push('terminalOpened', { name: t.name });
      }),
      vscode.window.onDidCloseTerminal((t) => {
        this.push('terminalClosed', { name: t.name });
      })
    );

    // Visible range changed (scrolling)
    this.disposables.push(
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
        const range = e.visibleRanges[0];
        if (range) {
          this.push('visibleRangeChanged', {
            file: e.textEditor.document.uri.fsPath,
            startLine: range.start.line,
            endLine: range.end.line,
          });
        }
      })
    );
  }

  /**
   * Poll: get events since a given timestamp
   */
  getEventsSince(since: number): EditorEvent[] {
    return this.events.filter(e => e.timestamp > since);
  }

  /**
   * Get last N events
   */
  getRecent(count: number): EditorEvent[] {
    return this.events.slice(-count);
  }

  /**
   * SSE handler
   */
  handleSSE(res: http.ServerResponse) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('data: {"type":"connected","timestamp":' + Date.now() + '}\n\n');
    this.sseClients.add(res);
    res.on('close', () => this.sseClients.delete(res));
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    for (const client of this.sseClients) {
      try { client.end(); } catch {}
    }
    this.sseClients.clear();
  }
}
