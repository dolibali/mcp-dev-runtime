import { existsSync, statSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export function defaultShell(platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform !== 'win32') return env.SHELL || '/bin/bash';
  const candidates = [
    path.join(env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    ...(env.PATH ?? '').split(path.delimiter).filter(Boolean).map(p => path.join(p, 'pwsh.exe')),
    path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  ];
  return candidates.find(file => { try { return path.isAbsolute(file) && statSync(file).isFile(); } catch { return false; } }) ?? candidates.at(-1)!;
}

export function shellKind(shell: string): 'powershell' | 'posix' | 'unsupported' {
  const name = path.basename(shell).toLowerCase();
  if (['powershell.exe', 'pwsh.exe'].includes(name)) return 'powershell';
  if (['bash.exe', 'sh.exe', 'zsh.exe'].includes(name)) return 'posix';
  return 'unsupported';
}

export async function windowsShellArgs(shell: string, command: string, login: boolean, tty: boolean): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
  const noop = async () => {};
  const kind = shellKind(shell);
  if (kind === 'posix') return { args: [login ? '-lc' : '-c', command], cleanup: noop };
  if (kind !== 'powershell') throw new Error('Windows shell must be powershell.exe, pwsh.exe or an explicitly installed POSIX shell. Run cmd.exe commands inside PowerShell.');
  // No permanent policy/profile changes. Suppress progress serialization, select
  // UTF-8, and preserve an explicit/native failure rather than converting it to 1.
  const prefix = "$ProgressPreference='SilentlyContinue'; $OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $global:LASTEXITCODE=0;\n";
  const suffix = '\n$__mdr_ok=$?; if (-not $__mdr_ok) { if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 1 }; exit 0\n';
  const script = prefix + command + suffix;
  const common = ['-NoLogo', ...(login ? [] : ['-NoProfile']), ...(tty ? [] : ['-NonInteractive']), '-OutputFormat', 'Text'];
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  if (encoded.length <= 24000) return { args: [...common, '-EncodedCommand', encoded], cleanup: noop };
  // Windows has a finite process command-line length. Large user scripts are
  // private UTF-8+BOM files; group execution policy is respected, never bypassed.
  const dir = path.join(tmpdir(), 'mdr-scripts-' + createHash('sha256').update(homedir()).digest('hex').slice(0, 16));
  const { windowsSecurity } = await import('./windows-host.js');
  await windowsSecurity('private-dir', dir);
  const filename = path.join(dir, randomUUID() + '.ps1');
  await writeFile(filename, '\ufeff' + script, { flag: 'wx' });
  return { args: [...common, '-File', filename], cleanup: () => unlink(filename).catch(e => { if (e.code !== 'ENOENT') throw e; }) };
}
