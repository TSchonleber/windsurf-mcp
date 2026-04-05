import * as vscode from 'vscode';
import * as https from 'https';

const CURRENT_VERSION = '1.0.0';
const GITHUB_API = 'https://api.github.com/repos/TSchonleber/windsurf-mcp/releases/latest';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // Once per day

export class UpdateChecker {
  private timer: NodeJS.Timeout | null = null;

  constructor(context: vscode.ExtensionContext) {
    // Check on startup (with 30s delay to not slow things down)
    setTimeout(() => this.check(context), 30000);

    // Then daily
    this.timer = setInterval(() => this.check(context), CHECK_INTERVAL_MS);
  }

  private async check(context: vscode.ExtensionContext) {
    // Don't nag more than once per day
    const lastCheck = context.globalState.get<number>('updateCheckTimestamp', 0);
    const lastDismissed = context.globalState.get<string>('updateDismissedVersion', '');
    const now = Date.now();

    if (now - lastCheck < CHECK_INTERVAL_MS) return;
    context.globalState.update('updateCheckTimestamp', now);

    try {
      const latest = await this.fetchLatestVersion();
      if (!latest) return;

      if (latest.version !== CURRENT_VERSION && latest.version !== lastDismissed) {
        if (this.isNewer(latest.version, CURRENT_VERSION)) {
          const action = await vscode.window.showInformationMessage(
            `Windsurf MCP Bridge v${latest.version} is available (you have v${CURRENT_VERSION})`,
            'Download',
            'Release Notes',
            'Dismiss'
          );

          if (action === 'Download') {
            vscode.env.openExternal(vscode.Uri.parse(latest.downloadUrl));
          } else if (action === 'Release Notes') {
            vscode.env.openExternal(vscode.Uri.parse(latest.htmlUrl));
          } else if (action === 'Dismiss') {
            context.globalState.update('updateDismissedVersion', latest.version);
          }
        }
      }
    } catch {
      // Silent fail — don't bother users with update check errors
    }
  }

  private fetchLatestVersion(): Promise<{ version: string; downloadUrl: string; htmlUrl: string } | null> {
    return new Promise((resolve) => {
      const req = https.get(GITHUB_API, {
        headers: { 'User-Agent': 'windsurf-mcp-bridge', 'Accept': 'application/json' },
        timeout: 5000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const release = JSON.parse(data);
            const version = (release.tag_name ?? '').replace(/^v/, '');
            const vsix = (release.assets ?? []).find((a: any) => a.name?.endsWith('.vsix'));
            resolve({
              version,
              downloadUrl: vsix?.browser_download_url ?? release.html_url,
              htmlUrl: release.html_url,
            });
          } catch {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }

  private isNewer(a: string, b: string): boolean {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
      if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
    }
    return false;
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
  }
}
