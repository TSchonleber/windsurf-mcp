import * as vscode from 'vscode';
import { execFile } from 'child_process';

// Inline chat — type @claude anywhere in a file, even across multiple lines.
//
// Supported formats:
//   // @claude do something
//   @claude do something
//   // @claude fix this function
//   // it's broken when x > 5
//   // and also handle the null case
//
// Waits 5 seconds after you stop typing before responding.

const RESPONSE_START = '// 🤖 ';
const RESPONSE_BLOCK_START = '/* 🤖 claude:';
const RESPONSE_BLOCK_END = '*/';

// Match @claude trigger — with or without comment prefix
const TRIGGER_LINE = /^(?:\s*(?:\/\/|#|--|\/\*)\s*)?@claude\s+(.+)$/;
// Continuation: lines right after @claude that are still "talking" (same comment style or plain text)
const CONTINUATION = /^(?:\s*(?:\/\/|#|--)\s*)(.+)$/;

interface PendingQuery {
  startLine: number;
  endLine: number;
  question: string;
  file: string;
  context: string;
}

export class InlineChat {
  private disposables: vscode.Disposable[] = [];
  private processing: Set<string> = new Set();
  private debounceTimer: NodeJS.Timeout | null = null;
  private answeredLines: Set<string> = new Set(); // "file:startLine" keys we've already answered
  private statusBarItem: vscode.StatusBarItem;

  constructor(context: vscode.ExtensionContext) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.statusBarItem.text = '$(comment-discussion) @claude ready';
    this.statusBarItem.tooltip = 'Type @claude <question> in any file to chat inline';
    this.statusBarItem.show();
    context.subscriptions.push(this.statusBarItem);

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme !== 'file') return;
        if (e.contentChanges.length === 0) return;

        // 5 second debounce — wait for user to finish typing
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.scanForTriggers(e.document);
        }, 5000);
      })
    );
  }

  private async scanForTriggers(doc: vscode.TextDocument) {
    let i = 0;
    while (i < doc.lineCount) {
      const lineText = doc.lineAt(i).text;
      const match = lineText.match(TRIGGER_LINE);
      if (!match) { i++; continue; }

      const triggerKey = `${doc.uri.fsPath}:${i}`;

      // Skip if already processing or answered
      if (this.processing.has(triggerKey) || this.answeredLines.has(triggerKey)) {
        i++;
        continue;
      }

      // Collect the question — first line
      const questionParts: string[] = [match[1].trim()];
      let endLine = i;

      // Check for multi-line: keep reading continuation lines
      // A continuation is a line right below that uses the same comment style
      // and doesn't start a new @claude trigger or a response
      const triggerPrefix = this.getCommentPrefix(lineText);
      
      for (let j = i + 1; j < doc.lineCount; j++) {
        const nextLine = doc.lineAt(j).text;
        const trimmed = nextLine.trim();

        // Stop at empty lines
        if (trimmed === '' || trimmed === '//' || trimmed === '#' || trimmed === '--') break;

        // Stop at responses
        if (trimmed.startsWith(RESPONSE_START.trim()) || trimmed.startsWith(RESPONSE_BLOCK_START.trim())) break;

        // Stop at new @claude triggers
        if (nextLine.match(TRIGGER_LINE)) break;

        // Stop at actual code (no comment prefix, and original had one)
        if (triggerPrefix && !this.hasCommentPrefix(nextLine)) break;

        // If no prefix on trigger, stop at lines that look like code
        if (!triggerPrefix && this.looksLikeCode(nextLine)) break;

        // It's a continuation
        const contMatch = nextLine.match(CONTINUATION);
        if (contMatch) {
          questionParts.push(contMatch[1].trim());
        } else if (!triggerPrefix) {
          // Plain text continuation (no comment prefix mode)
          questionParts.push(trimmed);
        } else {
          break;
        }
        endLine = j;
      }

      // Check if there's already a response after the block
      const lineAfterBlock = endLine + 1;
      if (lineAfterBlock < doc.lineCount) {
        const afterText = doc.lineAt(lineAfterBlock).text.trimStart();
        if (afterText.startsWith(RESPONSE_START.trim()) || afterText.startsWith(RESPONSE_BLOCK_START.trim())) {
          this.answeredLines.add(triggerKey);
          i = endLine + 1;
          continue;
        }
      }

      const question = questionParts.join(' ');
      if (!question) { i = endLine + 1; continue; }

      // Gather surrounding context
      const startCtx = Math.max(0, i - 30);
      const endCtx = Math.min(doc.lineCount, endLine + 30);
      const context = doc.getText(new vscode.Range(startCtx, 0, endCtx, 0));

      this.processing.add(triggerKey);
      this.statusBarItem.text = '$(loading~spin) @claude thinking...';

      try {
        await this.respond({
          startLine: i,
          endLine,
          question,
          file: doc.uri.fsPath,
          context,
        });
        this.answeredLines.add(triggerKey);
      } catch (err: any) {
        console.error('[inline-chat] Error:', err);
        await this.insertResponse(doc.uri, endLine, `Error: ${err.message}`);
      } finally {
        this.processing.delete(triggerKey);
        this.statusBarItem.text = '$(comment-discussion) @claude ready';
      }

      i = endLine + 1;
    }
  }

  private getCommentPrefix(line: string): string | null {
    const m = line.match(/^(\s*(?:\/\/|#|--)\s*)/);
    return m ? m[1] : null;
  }

  private hasCommentPrefix(line: string): boolean {
    return /^\s*(?:\/\/|#|--)/.test(line);
  }

  private looksLikeCode(line: string): boolean {
    const trimmed = line.trim();
    // Heuristics for "this is code, not natural language"
    if (trimmed.startsWith('import ') || trimmed.startsWith('export ')) return true;
    if (trimmed.startsWith('const ') || trimmed.startsWith('let ') || trimmed.startsWith('var ')) return true;
    if (trimmed.startsWith('function ') || trimmed.startsWith('class ') || trimmed.startsWith('interface ')) return true;
    if (trimmed.startsWith('if (') || trimmed.startsWith('for (') || trimmed.startsWith('while (')) return true;
    if (trimmed.startsWith('return ') || trimmed === '{' || trimmed === '}') return true;
    if (trimmed.startsWith('def ') || trimmed.startsWith('async ')) return true;
    return false;
  }

  private async respond(query: PendingQuery) {
    const prompt = `You are an inline code collaborator. The user typed @claude in their source file to talk to you.

File: ${query.file}
Language: ${query.file.split('.').pop()}

Code context around their message:
\`\`\`
${query.context}
\`\`\`

Their message: ${query.question}

Rules:
- You're writing directly into a source file. Be terse.
- If they ask a question, prefix each line with // 
- If they ask you to write/fix/add code, output raw code (no comment prefix, no markdown fences)
- 1-15 lines max unless they explicitly ask for more
- No markdown. No \`\`\` fences. Raw text only.`;

    const response = await this.callClaude(prompt);
    await this.insertResponse(vscode.Uri.file(query.file), query.endLine, response);
  }

  private async insertResponse(uri: vscode.Uri, afterLine: number, text: string) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();

    const lines = text.split('\n');
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    while (lines.length > 0 && lines[0].trim() === '') lines.shift();

    let formatted: string;
    if (lines.length <= 2) {
      formatted = lines.map(l => `${RESPONSE_START}${l}`).join('\n');
    } else {
      formatted = `${RESPONSE_BLOCK_START}\n${lines.map(l => `   ${l}`).join('\n')}\n${RESPONSE_BLOCK_END}`;
    }

    const insertPos = new vscode.Position(afterLine + 1, 0);
    edit.insert(uri, insertPos, formatted + '\n');
    await vscode.workspace.applyEdit(edit);

    // Green left-border highlight that fades
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
      setTimeout(() => decoration.dispose(), 8000);
    }
  }

  private callClaude(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
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
    const config = vscode.workspace.getConfiguration('windsurf-mcp');
    const custom = config.get<string>('claudePath', '');
    if (custom) return custom;

    return '/Users/r4vager/.local/bin/claude';
  }

  dispose() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    for (const d of this.disposables) d.dispose();
    this.statusBarItem.dispose();
  }
}
