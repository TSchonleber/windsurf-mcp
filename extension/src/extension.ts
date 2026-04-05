import * as vscode from 'vscode';
import * as http from 'http';
import { BridgeServer } from './bridge';
import { CompletionProvider } from './completions';
import { DiffPreview } from './diff-preview';
import { InlineChat } from './inline-chat';
import { SmartCompletions } from './smart-completions';

let bridge: BridgeServer | null = null;
let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('windsurf-mcp');
  const port = config.get<number>('port', 7749);

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'windsurf-mcp.showStatus';
  context.subscriptions.push(statusBarItem);

  // Start bridge
  bridge = new BridgeServer(port, context);
  bridge.start().then(() => {
    statusBarItem.text = `$(plug) MCP:${port}`;
    statusBarItem.tooltip = `Windsurf MCP Bridge — listening on port ${port}`;
    statusBarItem.show();
  }).catch(err => {
    vscode.window.showErrorMessage(`Windsurf MCP Bridge failed to start: ${err.message}`);
    statusBarItem.text = '$(error) MCP:ERR';
    statusBarItem.show();
  });

  // Completion provider
  if (config.get<boolean>('enableCompletions', true)) {
    const completionProvider = new CompletionProvider();
    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(
        { scheme: 'file' },
        completionProvider,
        '.', ':', '(', '{', '<'
      )
    );
    bridge.setCompletionProvider(completionProvider);
  }

  // Diff preview
  const diffPreview = new DiffPreview();
  bridge.setDiffPreview(diffPreview);

  // Inline chat — @claude in any file
  const inlineChat = new InlineChat(context);
  context.subscriptions.push({ dispose: () => inlineChat.dispose() });

  // Smart completions — brainctl-powered tab completions
  const smartCompletions = new SmartCompletions(context);
  context.subscriptions.push({ dispose: () => smartCompletions.dispose() });

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('windsurf-mcp.showStatus', () => {
      if (bridge) {
        const stats = bridge.getStats();
        vscode.window.showInformationMessage(
          `MCP Bridge: ${stats.connected ? 'Connected' : 'Disconnected'} | ` +
          `Port: ${port} | Requests: ${stats.requestCount} | ` +
          `Last: ${stats.lastRequest || 'never'}`
        );
      }
    }),
    vscode.commands.registerCommand('windsurf-mcp.restart', async () => {
      if (bridge) {
        await bridge.stop();
        await bridge.start();
        vscode.window.showInformationMessage('MCP Bridge restarted');
      }
    })
  );

  console.log(`[windsurf-mcp] Bridge activated on port ${port}`);
}

export function deactivate() {
  if (bridge) {
    bridge.stop();
  }
}
