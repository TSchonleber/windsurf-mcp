import * as vscode from 'vscode';
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Cross-platform claude CLI resolution.

let cachedClaudePath: string | null = null;

export function findClaudeBinary(): string {
  // Check config override first
  const config = vscode.workspace.getConfiguration('windsurf-mcp');
  const custom = config.get<string>('claudePath', '');
  if (custom) return custom;

  // Return cached if we already found it
  if (cachedClaudePath) return cachedClaudePath;

  const platform = os.platform();
  const home = os.homedir();

  // Platform-specific common locations
  const candidates: string[] = [];

  if (platform === 'win32') {
    candidates.push(
      path.join(home, 'AppData', 'Local', 'Programs', 'claude-code', 'claude.exe'),
      path.join(home, 'AppData', 'Local', 'npm', 'claude.cmd'),
      path.join(home, '.local', 'bin', 'claude.exe'),
      'C:\\Program Files\\Claude Code\\claude.exe',
    );
  } else if (platform === 'darwin') {
    candidates.push(
      path.join(home, '.local', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      path.join(home, '.npm-global', 'bin', 'claude'),
    );
  } else {
    // Linux
    candidates.push(
      path.join(home, '.local', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/usr/bin/claude',
      path.join(home, '.npm-global', 'bin', 'claude'),
    );
  }

  // Check each candidate
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        cachedClaudePath = candidate;
        return candidate;
      }
    } catch {}
  }

  // Try `which` / `where` as fallback
  try {
    const cmd = platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(cmd, ['claude'], { encoding: 'utf8', timeout: 3000 }).trim();
    if (result) {
      const firstLine = result.split('\n')[0].trim();
      if (firstLine && fs.existsSync(firstLine)) {
        cachedClaudePath = firstLine;
        return firstLine;
      }
    }
  } catch {}

  // Last resort — hope it's on PATH
  cachedClaudePath = 'claude';
  return 'claude';
}
