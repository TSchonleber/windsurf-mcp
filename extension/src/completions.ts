import * as vscode from 'vscode';

interface CompletionItem {
  label: string;
  insertText: string;
  detail?: string;
  documentation?: string;
  kind?: string;
}

const KIND_MAP: Record<string, vscode.CompletionItemKind> = {
  text: vscode.CompletionItemKind.Text,
  method: vscode.CompletionItemKind.Method,
  function: vscode.CompletionItemKind.Function,
  constructor: vscode.CompletionItemKind.Constructor,
  field: vscode.CompletionItemKind.Field,
  variable: vscode.CompletionItemKind.Variable,
  class: vscode.CompletionItemKind.Class,
  interface: vscode.CompletionItemKind.Interface,
  module: vscode.CompletionItemKind.Module,
  property: vscode.CompletionItemKind.Property,
  snippet: vscode.CompletionItemKind.Snippet,
  keyword: vscode.CompletionItemKind.Keyword,
  constant: vscode.CompletionItemKind.Constant,
  value: vscode.CompletionItemKind.Value,
};

export class CompletionProvider implements vscode.CompletionItemProvider {
  private items: CompletionItem[] = [];

  setItems(items: CompletionItem[]) {
    this.items = items;
  }

  clearItems() {
    this.items = [];
  }

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): vscode.CompletionItem[] {
    if (this.items.length === 0) return [];

    return this.items.map((item, i) => {
      const completion = new vscode.CompletionItem(item.label);
      completion.insertText = new vscode.SnippetString(item.insertText);
      completion.detail = item.detail ?? '✨ Claude';
      completion.documentation = item.documentation
        ? new vscode.MarkdownString(item.documentation)
        : undefined;
      completion.kind = KIND_MAP[item.kind ?? 'snippet'] ?? vscode.CompletionItemKind.Snippet;
      completion.sortText = `!${String(i).padStart(4, '0')}`; // sort to top
      return completion;
    });
  }
}
