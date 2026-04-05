import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Shows proposed changes as a diff view in the editor.
 * User can review and accept/reject.
 */
export class DiffPreview {
  private pendingDiffs: Map<string, string> = new Map();

  /**
   * Show a diff between the current file content and proposed new content
   */
  async show(filePath: string, newContent: string, title?: string): Promise<void> {
    const uri = vscode.Uri.file(filePath);

    // Store the proposed content for later apply
    this.pendingDiffs.set(filePath, newContent);

    // Create a virtual document with the proposed content
    const proposedUri = vscode.Uri.parse(
      `windsurf-mcp-proposed:${filePath}?${Date.now()}`
    );

    // Register a content provider for the proposed content
    const provider = new class implements vscode.TextDocumentContentProvider {
      provideTextDocumentContent(): string {
        return newContent;
      }
    };

    const registration = vscode.workspace.registerTextDocumentContentProvider(
      'windsurf-mcp-proposed', provider
    );

    const diffTitle = title ?? `Claude Proposed: ${path.basename(filePath)}`;
    await vscode.commands.executeCommand('vscode.diff', uri, proposedUri, diffTitle);

    // Clean up registration after a delay (keep it alive while diff is open)
    setTimeout(() => registration.dispose(), 300000); // 5 min
  }

  /**
   * Apply the pending diff for a file
   */
  async apply(filePath: string): Promise<boolean> {
    const newContent = this.pendingDiffs.get(filePath);
    if (!newContent) return false;

    const uri = vscode.Uri.file(filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      doc.positionAt(0),
      doc.positionAt(doc.getText().length)
    );
    edit.replace(uri, fullRange, newContent);
    const success = await vscode.workspace.applyEdit(edit);

    if (success) {
      this.pendingDiffs.delete(filePath);
    }
    return success;
  }
}
