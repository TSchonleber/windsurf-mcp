import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as http from 'http';
import * as path from 'path';

// Polls brainctl for project-relevant completions and pushes them to the completion provider.
// Watches active file changes and refreshes context-aware completions.

const BRIDGE_PORT = 7749;

interface BrainMemory {
  content: string;
  category: string;
  scope: string;
  tags?: string;
}

export class SmartCompletions {
  private disposables: vscode.Disposable[] = [];
  private lastFile: string | null = null;
  private lastLanguage: string | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private brainctlPath: string;

  constructor(context: vscode.ExtensionContext) {
    this.brainctlPath = this.findBrainctl();

    // Refresh completions when active file changes
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor) return;
        const file = editor.document.uri.fsPath;
        const lang = editor.document.languageId;

        // Only refresh if file or language changed
        if (file === this.lastFile && lang === this.lastLanguage) return;
        this.lastFile = file;
        this.lastLanguage = lang;

        this.scheduleRefresh();
      })
    );

    // Initial load
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      this.lastFile = editor.document.uri.fsPath;
      this.lastLanguage = editor.document.languageId;
      this.scheduleRefresh();
    }
  }

  private scheduleRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refreshCompletions(), 500);
  }

  private async refreshCompletions() {
    if (!this.lastFile || !this.lastLanguage) return;

    try {
      const items: any[] = [];

      // 1. Query brainctl for project conventions
      const projectName = this.extractProjectName(this.lastFile);
      const conventions = await this.queryBrain(`convention ${projectName} ${this.lastLanguage}`);

      for (const mem of conventions) {
        // Turn conventions into completion snippets
        const snippet = this.conventionToSnippet(mem, this.lastLanguage);
        if (snippet) items.push(snippet);
      }

      // 2. Query for decisions relevant to this project
      const decisions = await this.queryBrain(`decision ${projectName}`);
      for (const mem of decisions) {
        items.push({
          label: `📋 ${mem.content.slice(0, 40)}...`,
          insertText: `// Decision: ${mem.content}`,
          detail: '✨ brainctl decision',
          documentation: mem.content,
          kind: 'text',
        });
      }

      // 3. Language-specific patterns from lessons
      const lessons = await this.queryBrain(`${this.lastLanguage} pattern lesson`);
      for (const mem of lessons) {
        const snippet = this.lessonToSnippet(mem, this.lastLanguage);
        if (snippet) items.push(snippet);
      }

      // 4. Get diagnostics for current file and suggest fixes
      const diags = await this.getDiagnostics(this.lastFile);
      for (const diag of diags.slice(0, 3)) {
        if (diag.severity === 'Error') {
          items.push({
            label: `🔧 Fix: ${diag.message.slice(0, 50)}`,
            insertText: `// TODO: Fix — ${diag.message}`,
            detail: `✨ Line ${diag.range.startLine + 1}`,
            documentation: `**${diag.source ?? 'Diagnostic'}:** ${diag.message}\n\nAt line ${diag.range.startLine + 1}`,
            kind: 'text',
          });
        }
      }

      // Push to the extension's completion provider
      if (items.length > 0) {
        await this.pushCompletions(items);
      }

    } catch (err) {
      console.error('[smart-completions]', err);
    }
  }

  private async queryBrain(query: string): Promise<BrainMemory[]> {
    return new Promise((resolve) => {
      execFile(this.brainctlPath, ['-a', 'windsurf', 'memory', 'search', query, '--json'], {
        timeout: 5000,
        maxBuffer: 512 * 1024,
      }, (err, stdout) => {
        if (err) { resolve([]); return; }
        try {
          const parsed = JSON.parse(stdout);
          resolve(parsed.memories ?? parsed.results ?? []);
        } catch {
          resolve([]);
        }
      });
    });
  }

  private async getDiagnostics(filePath: string): Promise<any[]> {
    return new Promise((resolve) => {
      const body = JSON.stringify({ path: filePath, severities: ['Error', 'Warning'] });
      const req = http.request({
        hostname: '127.0.0.1', port: BRIDGE_PORT,
        path: '/api/diagnostics', method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 2000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data).diagnostics ?? []); }
          catch { resolve([]); }
        });
      });
      req.on('error', () => resolve([]));
      req.write(body);
      req.end();
    });
  }

  private async pushCompletions(items: any[]) {
    return new Promise<void>((resolve) => {
      const body = JSON.stringify({ items });
      const req = http.request({
        hostname: '127.0.0.1', port: BRIDGE_PORT,
        path: '/api/completions/push', method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 2000,
      }, () => resolve());
      req.on('error', () => resolve());
      req.write(body);
      req.end();
    });
  }

  private extractProjectName(filePath: string): string {
    // Pull project name from workspace folder or path
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspace) return path.basename(workspace);
    // Fallback: grab from path
    const parts = filePath.split('/');
    const srcIdx = parts.indexOf('src');
    if (srcIdx > 0) return parts[srcIdx - 1];
    return parts[parts.length - 2] ?? 'unknown';
  }

  private conventionToSnippet(mem: BrainMemory, lang: string): any | null {
    const content = mem.content;

    // Try to extract code patterns from the convention
    const codeMatch = content.match(/`([^`]+)`/);
    if (codeMatch) {
      return {
        label: `📐 ${content.slice(0, 50)}`,
        insertText: codeMatch[1],
        detail: '✨ brainctl convention',
        documentation: content,
        kind: 'snippet',
      };
    }

    return {
      label: `📐 ${content.slice(0, 50)}`,
      insertText: `// Convention: ${content}`,
      detail: '✨ brainctl convention',
      documentation: content,
      kind: 'text',
    };
  }

  private lessonToSnippet(mem: BrainMemory, lang: string): any | null {
    const content = mem.content;
    return {
      label: `💡 ${content.slice(0, 50)}`,
      insertText: `// Lesson: ${content}`,
      detail: '✨ brainctl lesson',
      documentation: content,
      kind: 'text',
    };
  }

  private findBrainctl(): string {
    const candidates = [
      '/Users/r4vager/bin/brainctl',
      '/Users/r4vager/.local/bin/brainctl',
      'brainctl',
    ];
    return candidates[0];
  }

  dispose() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const d of this.disposables) d.dispose();
  }
}
