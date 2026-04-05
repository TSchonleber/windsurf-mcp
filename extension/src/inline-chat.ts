import * as vscode from 'vscode';
import { spawn } from 'child_process';

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
// Streams response tokens in real-time — you see each word appear.

const RESPONSE_START = '// 🤖 ';
const RESPONSE_BLOCK_START = '/* 🤖 claude:';
const RESPONSE_BLOCK_END = '*/';

const TRIGGER_LINE = /^(?:\s*(?:\/\/|#|--|\/\*)\s*)?@claude\s+(.+)$/;
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
  private answeredLines: Set<string> = new Set();
  private statusBarItem: vscode.StatusBarItem;
  private activeDecoration: vscode.TextEditorDecorationType | null = null;

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

      if (this.processing.has(triggerKey) || this.answeredLines.has(triggerKey)) {
        i++;
        continue;
      }

      const questionParts: string[] = [match[1].trim()];
      let endLine = i;

      const triggerPrefix = this.getCommentPrefix(lineText);

      for (let j = i + 1; j < doc.lineCount; j++) {
        const nextLine = doc.lineAt(j).text;
        const trimmed = nextLine.trim();

        if (trimmed === '' || trimmed === '//' || trimmed === '#' || trimmed === '--') break;
        if (trimmed.startsWith(RESPONSE_START.trim()) || trimmed.startsWith(RESPONSE_BLOCK_START.trim())) break;
        if (nextLine.match(TRIGGER_LINE)) break;
        if (triggerPrefix && !this.hasCommentPrefix(nextLine)) break;
        if (!triggerPrefix && this.looksLikeCode(nextLine)) break;

        const contMatch = nextLine.match(CONTINUATION);
        if (contMatch) {
          questionParts.push(contMatch[1].trim());
        } else if (!triggerPrefix) {
          questionParts.push(trimmed);
        } else {
          break;
        }
        endLine = j;
      }

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

      const startCtx = Math.max(0, i - 30);
      const endCtx = Math.min(doc.lineCount, endLine + 20);
      const context = doc.getText(new vscode.Range(startCtx, 0, endCtx, 0));

      this.processing.add(triggerKey);
      this.statusBarItem.text = '$(loading~spin) @claude thinking...';

      try {
        await this.respondStreaming({
          startLine: i,
          endLine,
          question,
          file: doc.uri.fsPath,
          context,
        });
        this.answeredLines.add(triggerKey);
      } catch (err: any) {
        console.error('[inline-chat] Error:', err);
        await this.insertFinalResponse(vscode.Uri.file(doc.uri.fsPath), endLine, `Error: ${err.message}`);
      } finally {
        this.processing.delete(triggerKey);
        this.statusBarItem.text = '$(comment-discussion) @claude ready';
      }

      i = endLine + 1;
    }
  }

  private async respondStreaming(query: PendingQuery) {
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

    const uri = vscode.Uri.file(query.file);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === uri.fsPath);

    // Insert placeholder
    const insertLine = query.endLine + 1;
    const placeholderEdit = new vscode.WorkspaceEdit();
    placeholderEdit.insert(uri, new vscode.Position(insertLine, 0), `${RESPONSE_START}...\n`);
    await vscode.workspace.applyEdit(placeholderEdit);

    // Track accumulated text
    let accumulated = '';
    let currentResponseLines = 1;

    // Set up streaming decoration
    if (this.activeDecoration) this.activeDecoration.dispose();
    this.activeDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(74, 222, 128, 0.08)',
      isWholeLine: true,
      border: '1px solid rgba(74, 222, 128, 0.3)',
      borderWidth: '0 0 0 3px',
    });

    return new Promise<void>((resolve, reject) => {
      const claudePath = this.findClaude();

      const proc = spawn(claudePath, [
        '-p', prompt,
        '--output-format', 'stream-json',
        '--no-session-persistence',
      ], {
        env: { ...process.env, NO_COLOR: '1' },
        timeout: 60000,
      });

      let buffer = '';

      proc.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // keep incomplete line

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === 'assistant' && event.subtype === 'text') {
              // Streaming text delta
              accumulated += event.text ?? '';
              this.updateResponse(uri, insertLine, accumulated, editor);
            } else if (event.type === 'result') {
              // Final result
              const finalText = event.result ?? accumulated;
              accumulated = finalText;
            }
          } catch {
            // Not JSON or partial — skip
          }
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        console.error('[inline-chat] stderr:', chunk.toString());
      });

      proc.on('close', async (code) => {
        // Replace with final formatted response
        try {
          await this.replaceFinalResponse(uri, insertLine, accumulated);
          // Fade decoration
          if (this.activeDecoration) {
            setTimeout(() => {
              this.activeDecoration?.dispose();
              this.activeDecoration = null;
            }, 8000);
          }
          resolve();
        } catch (err: any) {
          reject(err);
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`claude CLI failed: ${err.message}`));
      });

      setTimeout(() => {
        proc.kill();
        reject(new Error('Timeout — claude took too long'));
      }, 60000);
    });
  }

  private async updateResponse(uri: vscode.Uri, startLine: number, text: string, editor?: vscode.TextEditor) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const lines = text.split('\n');
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    if (lines.length === 0) return;

    // Build the streaming display — single line or multi
    let display: string;
    if (lines.length <= 2) {
      display = lines.map(l => `${RESPONSE_START}${l}`).join('\n') + '\n';
    } else {
      display = `${RESPONSE_BLOCK_START}\n${lines.map(l => `   ${l}`).join('\n')}\n${RESPONSE_BLOCK_END}\n`;
    }

    // Figure out how many lines the current response occupies
    const currentText = doc.getText();
    const allLines = currentText.split('\n');

    // Find the response block start
    let responseEnd = startLine;
    for (let i = startLine; i < allLines.length; i++) {
      const trimmed = allLines[i].trimStart();
      if (trimmed.startsWith(RESPONSE_START.trim()) ||
          trimmed.startsWith(RESPONSE_BLOCK_START.trim()) ||
          trimmed.startsWith(RESPONSE_BLOCK_END.trim()) ||
          trimmed.startsWith('   ')) { // indented content in block
        responseEnd = i + 1;
      } else {
        break;
      }
    }

    const edit = new vscode.WorkspaceEdit();
    const range = new vscode.Range(startLine, 0, responseEnd, 0);
    edit.replace(uri, range, display);
    await vscode.workspace.applyEdit(edit);

    // Update decoration
    if (editor && this.activeDecoration) {
      const displayLines = display.split('\n').length - 1;
      const decorRange = new vscode.Range(startLine, 0, startLine + displayLines, 0);
      editor.setDecorations(this.activeDecoration, [decorRange]);
    }
  }

  private async replaceFinalResponse(uri: vscode.Uri, startLine: number, text: string) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const lines = text.split('\n');
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    while (lines.length > 0 && lines[0].trim() === '') lines.shift();
    if (lines.length === 0) lines.push('(no response)');

    let formatted: string;
    if (lines.length <= 2) {
      formatted = lines.map(l => `${RESPONSE_START}${l}`).join('\n') + '\n';
    } else {
      formatted = `${RESPONSE_BLOCK_START}\n${lines.map(l => `   ${l}`).join('\n')}\n${RESPONSE_BLOCK_END}\n`;
    }

    // Find current response extent
    const allLines = doc.getText().split('\n');
    let responseEnd = startLine;
    for (let i = startLine; i < allLines.length; i++) {
      const trimmed = allLines[i].trimStart();
      if (trimmed.startsWith(RESPONSE_START.trim()) ||
          trimmed.startsWith(RESPONSE_BLOCK_START.trim()) ||
          trimmed.startsWith(RESPONSE_BLOCK_END.trim()) ||
          trimmed.startsWith('   ')) {
        responseEnd = i + 1;
      } else {
        break;
      }
    }

    const edit = new vscode.WorkspaceEdit();
    const range = new vscode.Range(startLine, 0, responseEnd, 0);
    edit.replace(uri, range, formatted);
    await vscode.workspace.applyEdit(edit);
  }

  private async insertFinalResponse(uri: vscode.Uri, afterLine: number, text: string) {
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(afterLine + 1, 0), `${RESPONSE_START}${text}\n`);
    await vscode.workspace.applyEdit(edit);
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
    if (trimmed.startsWith('import ') || trimmed.startsWith('export ')) return true;
    if (trimmed.startsWith('const ') || trimmed.startsWith('let ') || trimmed.startsWith('var ')) return true;
    if (trimmed.startsWith('function ') || trimmed.startsWith('class ') || trimmed.startsWith('interface ')) return true;
    if (trimmed.startsWith('if (') || trimmed.startsWith('for (') || trimmed.startsWith('while (')) return true;
    if (trimmed.startsWith('return ') || trimmed === '{' || trimmed === '}') return true;
    if (trimmed.startsWith('def ') || trimmed.startsWith('async ')) return true;
    return false;
  }

  private findClaude(): string {
    const config = vscode.workspace.getConfiguration('windsurf-mcp');
    const custom = config.get<string>('claudePath', '');
    if (custom) return custom;
    return '/Users/r4vager/.local/bin/claude';
  }

  dispose() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.activeDecoration) this.activeDecoration.dispose();
    for (const d of this.disposables) d.dispose();
    this.statusBarItem.dispose();
  }
}
