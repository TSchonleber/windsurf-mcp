import * as vscode from 'vscode';
import { spawn, execFile } from 'child_process';
import { dispatchTools } from './tool-dispatch';
import { findClaudeBinary } from './platform';

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
// Streams response tokens in real-time.

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
  private activeDecorations: Map<string, vscode.TextEditorDecorationType> = new Map();

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
      if (this.processing.has(triggerKey) || this.answeredLines.has(triggerKey)) { i++; continue; }

      // Collect multi-line question
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

      // Skip if already answered
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

      // Detect follow-ups
      let followUp: { previousQuestion: string; previousResponse: string } | undefined;
      if (i > 0) {
        for (let k = i - 1; k >= 0; k--) {
          const prevLine = doc.lineAt(k).text.trimStart();
          if (prevLine.startsWith(RESPONSE_START.trim()) || prevLine.startsWith(RESPONSE_BLOCK_END)) {
            const respLines: string[] = [];
            for (let r = k; r >= 0; r--) {
              const rl = doc.lineAt(r).text.trimStart();
              respLines.unshift(doc.lineAt(r).text);
              if (rl.startsWith(RESPONSE_BLOCK_START.trim()) || rl.startsWith(RESPONSE_START.trim())) {
                if (r > 0) {
                  const qMatch = doc.lineAt(r - 1).text.match(TRIGGER_LINE);
                  if (qMatch) {
                    followUp = {
                      previousQuestion: qMatch[1].trim(),
                      previousResponse: respLines.join('\n'),
                    };
                  }
                }
                break;
              }
            }
            break;
          } else if (prevLine === '') {
            continue;
          } else {
            break;
          }
        }
      }

      this.processing.add(triggerKey);
      this.statusBarItem.text = '$(loading~spin) @claude thinking...';

      // Fire without awaiting — parallel processing
      this.respond({ startLine: i, endLine, question, file: doc.uri.fsPath, context }, followUp)
        .then(() => this.answeredLines.add(triggerKey))
        .catch((err: any) => {
          console.error('[inline-chat] Error:', err);
          this.insertText(vscode.Uri.file(doc.uri.fsPath), endLine + 1, `${RESPONSE_START}Error: ${err.message}\n`);
        })
        .finally(() => {
          this.processing.delete(triggerKey);
          if (this.processing.size === 0) {
            this.statusBarItem.text = '$(comment-discussion) @claude ready';
          }
        });

      i = endLine + 1;
    }
  }

  private async respond(query: PendingQuery, followUp?: { previousQuestion: string; previousResponse: string }) {
    const toolResults = await dispatchTools(query.question, query.file, query.startLine);
    const toolContext = toolResults.length > 0
      ? `\n\nTool results from the editor:\n${toolResults.map(r => `[${r.toolName}]\n${r.summary}`).join('\n\n')}`
      : '';

    const prompt = `You are an inline code collaborator. The user typed @claude in their source file to talk to you.

File: ${query.file}
Language: ${query.file.split('.').pop()}

Code context around their message:
\`\`\`
${query.context}
\`\`\`
${toolContext}

${followUp ? `Previous conversation in this file:
User: ${followUp.previousQuestion}
Assistant: ${followUp.previousResponse}

This is a FOLLOW-UP. The user is continuing the conversation.
` : ''}Their message: ${query.question}

Rules:
- Be terse. 1-15 lines max.
- Do NOT add comment prefixes (no // or # or --). The system wraps your response automatically.
- If they ask you to write code, output raw code.
- No markdown. No \`\`\` fences. No comment syntax. Just the raw answer text.
${toolResults.length > 0 ? '- Tool results above are REAL data from the editor. Use them in your answer. Be specific.' : ''}`;

    const uri = vscode.Uri.file(query.file);
    const insertLine = query.endLine + 1;

    // Insert placeholder
    await this.insertText(uri, insertLine, `${RESPONSE_START}...\n`);

    // Set up highlight decoration
    const decoKey = `${query.file}:${insertLine}`;
    const decoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(74, 222, 128, 0.08)',
      isWholeLine: true,
      border: '1px solid rgba(74, 222, 128, 0.3)',
      borderWidth: '0 0 0 3px',
    });
    this.activeDecorations.set(decoKey, decoration);

    const claudePath = findClaudeBinary();

    return new Promise<void>((resolve, reject) => {
      const proc = spawn(claudePath, [
        '-p', prompt,
        '--output-format', 'stream-json',
        '--verbose',
        '--no-session-persistence',
      ], {
        env: { ...process.env, NO_COLOR: '1' },
      });

      let buffer = '';
      let accumulated = '';
      let updateScheduled = false;

      proc.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        let changed = false;
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === 'assistant' && event.message?.content) {
              const textBlocks = event.message.content.filter((b: any) => b.type === 'text');
              const fullText = textBlocks.map((b: any) => b.text).join('');
              if (fullText && fullText !== accumulated) {
                accumulated = fullText;
                changed = true;
              }
            } else if (event.type === 'result' && event.result) {
              accumulated = event.result;
              changed = true;
            }
          } catch {}
        }

        // Throttle updates to avoid flicker — max once per 100ms
        if (changed && !updateScheduled) {
          updateScheduled = true;
          setTimeout(() => {
            updateScheduled = false;
            this.updateStreamingResponse(uri, insertLine, accumulated, decoration);
          }, 100);
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        console.error('[inline-chat] stderr:', chunk.toString());
      });

      proc.on('close', async () => {
        try {
          // Strip comment prefixes Claude might add
          const clean = accumulated.trim()
            .split('\n')
            .map(l => l.replace(/^\s*\/\/\s?/, '').replace(/^\s*#\s?/, '').replace(/^\s*--\s?/, ''))
            .join('\n')
            .trim();
          await this.writeResponse(uri, insertLine, clean || '(no response)');
          // Fade decoration
          setTimeout(() => {
            decoration.dispose();
            this.activeDecorations.delete(decoKey);
          }, 8000);
          resolve();
        } catch (e: any) {
          reject(e);
        }
      });

      proc.on('error', (err) => reject(new Error(`claude CLI failed: ${err.message}`)));

      // Timeout
      const timer = setTimeout(() => { proc.kill(); reject(new Error('Timeout')); }, 60000);
      proc.on('close', () => clearTimeout(timer));
    });
  }

  private async updateStreamingResponse(uri: vscode.Uri, startLine: number, text: string, decoration: vscode.TextEditorDecorationType) {
    const doc = await vscode.workspace.openTextDocument(uri);
    // Strip prefixes for display
    const clean = text.trim()
      .split('\n')
      .map(l => l.replace(/^\s*\/\/\s?/, '').replace(/^\s*#\s?/, '').replace(/^\s*--\s?/, ''))
      .join('\n')
      .trim();
    if (!clean) return;

    const display = this.formatResponse(clean);
    const displayLineCount = display.split('\n').length;

    // Find current response extent
    const responseEnd = this.findResponseEnd(doc, startLine);

    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(startLine, 0, responseEnd, 0), display);
    await vscode.workspace.applyEdit(edit);

    // Update decoration
    const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === uri.fsPath);
    if (editor) {
      editor.setDecorations(decoration, [new vscode.Range(startLine, 0, startLine + displayLineCount - 1, 0)]);
    }
  }

  private async writeResponse(uri: vscode.Uri, startLine: number, text: string) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const display = this.formatResponse(text);
    const responseEnd = this.findResponseEnd(doc, startLine);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(startLine, 0, responseEnd, 0), display);
    await vscode.workspace.applyEdit(edit);
  }

  private formatResponse(text: string): string {
    const lines = text.split('\n');
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    while (lines.length > 0 && lines[0].trim() === '') lines.shift();
    if (lines.length === 0) return `${RESPONSE_START}(no response)\n`;

    if (lines.length <= 2) {
      return lines.map(l => `${RESPONSE_START}${l}`).join('\n') + '\n';
    }
    return `${RESPONSE_BLOCK_START}\n${lines.map(l => `   ${l}`).join('\n')}\n${RESPONSE_BLOCK_END}\n`;
  }

  private findResponseEnd(doc: vscode.TextDocument, startLine: number): number {
    let end = startLine;
    for (let i = startLine; i < doc.lineCount; i++) {
      const t = doc.lineAt(i).text.trimStart();
      if (t.startsWith(RESPONSE_START.trim()) || t.startsWith(RESPONSE_BLOCK_START.trim()) ||
          t.startsWith(RESPONSE_BLOCK_END) || t.startsWith('   ')) {
        end = i + 1;
      } else {
        break;
      }
    }
    return end;
  }

  private async insertText(uri: vscode.Uri, line: number, text: string) {
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(line, 0), text);
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
    const t = line.trim();
    return /^(?:import |export |const |let |var |function |class |interface |if \(|for \(|while \(|return |def |async )/.test(t) || t === '{' || t === '}';
  }

  dispose() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    for (const d of this.activeDecorations.values()) d.dispose();
    for (const d of this.disposables) d.dispose();
    this.statusBarItem.dispose();
  }
}
