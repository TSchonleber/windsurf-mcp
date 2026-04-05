import * as vscode from 'vscode';
import { execFile } from 'child_process';

const TRIGGER = /\/\/\s*@claude\s+(.+)$/;
const RESPONSE_START = '// 🤖 ';
const RESPONSE_BLOCK_START = '/* 🤖 claude:';
const RESPONSE_BLOCK_END = '*/';

interface PendingQuery {
  line: number;
  question: string;
  file: string;
  context: string;
}

export class InlineChat {
  private disposables: vscode.Disposable[] = [];
  private processing: Set<string> = new Set();
  private debounceTimer: NodeJS.Timeout | null = null;
  private statusBarItem: vscode.StatusBarItem;

  constructor(context: vscode.ExtensionContext) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.statusBarItem.text = '$(comment-discussion) @claude ready';
    this.statusBarItem.tooltip = 'Type // @claude <question> in any file to chat inline';
    this.statusBarItem.show();
    context.subscriptions.push(this.statusBarItem);

    // Watch for document changes
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme !== 'file') return;
        if (e.contentChanges.length === 0) return;

        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.scanForTriggers(e.document);
        }, 800);
      })
    );

    // Also scan on save
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        this.scanForTriggers(doc);
      })
    );
  }

  private async scanForTriggers(doc: vscode.TextDocument) {
    for (let i = 0; i < doc.lineCount; i++) {
      const lineText = doc.lineAt(i).text;
      const match = lineText.match(TRIGGER);
      if (!match) continue;

      const key = `${doc.uri.fsPath}:${i}`;

      if (this.processing.has(key)) continue;

      // Check if next line is already a response
      if (i + 1 < doc.lineCount) {
        const nextLine = doc.lineAt(i + 1).text.trimStart();
        if (nextLine.startsWith(RESPONSE_START) || nextLine.startsWith(RESPONSE_BLOCK_START)) {
          continue;
        }
      }

      const question = match[1].trim();
      if (!question) continue;

      // Gather context
      const startCtx = Math.max(0, i - 30);
      const endCtx = Math.min(doc.lineCount, i + 20);
      const context = doc.getText(new vscode.Range(startCtx, 0, endCtx, 0));

      this.processing.add(key);
      this.statusBarItem.text = '$(loading~spin) @claude thinking...';

      try {
        await this.respond({ line: i, question, file: doc.uri.fsPath, context });
      } catch (err: any) {
        console.error('[inline-chat] Error:', err);
        await this.insertResponse(doc.uri, i, `Error: ${err.message}`);
      } finally {
        this.processing.delete(key);
        this.statusBarItem.text = '$(comment-discussion) @claude ready';
      }
    }
  }

  private async respond(query: PendingQuery) {
    const prompt = `You are an inline code collaborator. The user typed // @claude in their code file.

File: ${query.file}
Language: ${query.file.split('.').pop()}

Context around the @claude comment:
\`\`\`
${query.context}
\`\`\`

The user's request: ${query.question}

Rules:
- Answer concisely. You're writing inside a source file.
- If they ask a question, prefix each line with // 
- If they ask you to write/fix/add code, output the code directly (no comment prefix, no fences)
- 1-10 lines max. Be terse.
- No markdown. No \`\`\` fences. Raw text only.`;

    const response = await this.callClaude(prompt);
    await this.insertResponse(vscode.Uri.file(query.file), query.line, response);
  }

  private async insertResponse(uri: vscode.Uri, afterLine: number, text: string) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();

    const lines = text.split('\n');
    // Trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

    let formatted: string;
    if (lines.length === 1) {
      formatted = `${RESPONSE_START}${lines[0]}`;
    } else {
      formatted = `${RESPONSE_BLOCK_START}\n${lines.map(l => `   ${l}`).join('\n')}\n${RESPONSE_BLOCK_END}`;
    }

    const insertPos = new vscode.Position(afterLine + 1, 0);
    edit.insert(uri, insertPos, formatted + '\n');
    await vscode.workspace.applyEdit(edit);

    // Green highlight that fades
    const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === uri.fsPath);
    if (editor) {
      const responseStart = afterLine + 1;
      const responseEnd = responseStart + formatted.split('\n').length;
      const range = new vscode.Range(responseStart, 0, responseEnd, 0);

      const decoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(74, 222, 128, 0.08)',
        isWholeLine: true,
        border: '1px solid rgba(74, 222, 128, 0.3)',
        borderWidth: '0 0 0 3px',
      });
      editor.setDecorations(decoration, [range]);
      setTimeout(() => decoration.dispose(), 5000);
    }
  }

  private callClaude(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // Use claude CLI with -p (print mode) — uses existing OAuth, no API key needed
      const claudePath = this.findClaude();

      execFile(claudePath, ['-p', prompt], {
        timeout: 60000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, NO_COLOR: '1' },
      }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`claude CLI failed: ${err.message}${stderr ? ` — ${stderr}` : ''}`));
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

  private findClaude(): string {
    // Check common locations
    const candidates = [
      '/Users/r4vager/.local/bin/claude',
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      'claude', // PATH fallback
    ];

    // Use the config override if set
    const config = vscode.workspace.getConfiguration('windsurf-mcp');
    const custom = config.get<string>('claudePath', '');
    if (custom) return custom;

    // Default to the known location
    return candidates[0];
  }

  dispose() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    for (const d of this.disposables) d.dispose();
    this.statusBarItem.dispose();
  }
}
