import { execFile } from 'node:child_process';
import { promisify, parseEnv } from 'node:util';
import { readFile } from 'node:fs/promises';
import type { LaunchOptions } from './options.js';
const exec = promisify(execFile);
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const keys = ['CONTROL_PLANE_API_KEY','CONTROL_PLANE_TUNNEL_ID','OPENAI_API_KEY',
  'PATH','HOME','SHELL','LANG','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY',
  'https_proxy','http_proxy','all_proxy','no_proxy','SSL_CERT_FILE','SSL_CERT_DIR'];
export async function launchEnvironment(o: LaunchOptions): Promise<NodeJS.ProcessEnv> {
  const fromFile = o.env_file ? parseEnv(await readFile(o.env_file, 'utf8')) : {};
  const inherited = { ...process.env };
  for (const k of ['CONTROL_PLANE_API_KEY','CONTROL_PLANE_TUNNEL_ID','OPENAI_API_KEY']) if (!inherited[k]) delete inherited[k];
  let env = { ...fromFile, ...inherited };
  if(process.platform==='win32'){
    const {windowsEnvironment}=await import('../platform/windows-host.js');
    env=windowsEnvironment(fromFile,inherited);
  }
  if ((!env.CONTROL_PLANE_API_KEY || !env.CONTROL_PLANE_TUNNEL_ID) && o.shell_env) {
    if(process.platform==='win32')throw new Error('Windows does not source a Unix login shell. Supply exported variables or runtime.env; no profile or execution policy is modified.');
    const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
    const marker = '__MCP_DEV_RUNTIME_ENV__';
    const script = `console.log(${JSON.stringify(marker)} + JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]))))`;
    try {
      const r = await exec(shell, ['-lic', `set +x; ${quote(process.execPath)} -e ${quote(script)}`], {
        env, timeout: 10000, maxBuffer: 4 * 1024 * 1024
      });
      const line = r.stdout.split('\n').findLast(s => s.startsWith(marker));
      if (!line) throw new Error('No environment result');
      env = { ...JSON.parse(line.slice(marker.length)), ...fromFile, ...inherited };
    } catch {
      // Do not expose captured startup output; it may contain user secrets.
      throw new Error('Could not load the login-shell environment. Supply exported variables or --env-file.');
    }
  }
  if (!env.CONTROL_PLANE_API_KEY && env.OPENAI_API_KEY) env.CONTROL_PLANE_API_KEY = env.OPENAI_API_KEY;
  if (!env.CONTROL_PLANE_API_KEY || !env.CONTROL_PLANE_TUNNEL_ID) {
    throw new Error('Missing CONTROL_PLANE_API_KEY or CONTROL_PLANE_TUNNEL_ID. Use --env-file or --shell-env; credentials are not stored by the launcher.');
  }
  if (!/^tunnel_[a-f0-9]{32}$/.test(env.CONTROL_PLANE_TUNNEL_ID)) throw new Error('Invalid CONTROL_PLANE_TUNNEL_ID format.');
  return env;
}
export function mcpEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  if(process.platform==='win32'){
    const privateKeys=new Set(['CONTROL_PLANE_API_KEY','OPENAI_API_KEY','OPENAI_ADMIN_KEY','NODE_TEST_CONTEXT','MDR_STDIN_CONTROL']);
    for(const key of Object.keys(copy))if(privateKeys.has(key.toUpperCase()))delete copy[key];
    return copy;
  }
  for (const key of ['CONTROL_PLANE_API_KEY','OPENAI_API_KEY','OPENAI_ADMIN_KEY','NODE_TEST_CONTEXT']) delete copy[key];
  return copy;
}
