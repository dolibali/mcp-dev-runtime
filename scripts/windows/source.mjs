import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { cp, readFile, writeFile, realpath, unlink } from 'node:fs/promises';
import { directories, project, info, json, hash, safeRoot, security, atomicJson, commandConflict, installationPaths, currentState } from './common.mjs';

if (process.platform !== 'win32') throw new Error('Use the existing install.sh / command scripts on macOS or Linux.');
const root = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const { values } = parseArgs({ options: { 'commands-only': { type: 'boolean' }, remove: { type: 'boolean' },
  'bin-dir': { type: 'string' }, name:{type:'string'}, 'no-global-command': { type: 'boolean' }, 'local-only': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
if (values.help) {
  console.log('Windows source setup: install.ps1 [--local-only] [--no-global-command] [--bin-dir PATH]\nRequires Node 24+ and a Go version that supports the pinned toolchain. No system dependencies, services or execution policies are installed.');
  process.exit(0);
}
const run = (exe, args) => execFileSync(exe, args, { cwd: root, windowsHide: true, stdio: 'inherit', timeout: 600000 });
const helper = path.join(root, '.runtime', 'bin', 'mdr-windows-host.exe');
const bin = safeRoot(path.resolve(values['bin-dir'] ?? directories().bin));
const manifest = path.join(bin, 'mdr-command.json');
const old = await json(manifest);
if(values.name&&!['mcp-dev-runtime','mdr'].includes(values.name))throw new Error('Command name must be mcp-dev-runtime or mdr.');
const requested=values.name?[values.name]:values['commands-only']?['mcp-dev-runtime']:['mcp-dev-runtime','mdr'];
if ((values.remove||!values['no-global-command']) && old && (old.project !== project || old.kind !== 'source' || old.root !== root)) throw new Error('Another installation owns this command directory.');
if (values.remove) {
  if (!old) { console.log('No source command registration found.'); process.exit(0); }
  const remaining={...old.commands};
  for (const name of requested.map(n=>n+'.exe')) {
    const file = path.join(bin, name), st = await info(file);
    if (st?.isFile() && !st.isSymbolicLink() && await hash(file) === old.commands?.[name]) await unlink(file);
    else if (st) console.log('Kept unrelated or changed command: ' + file);
    delete remaining[name];
  }
  if(Object.keys(remaining).length)await atomicJson(manifest,{...old,commands:remaining});else await unlink(manifest);
  console.log('Removed owned command registration. Source, settings and running services were not changed.');
  process.exit(0);
}
if (!values['commands-only']) {
  const selected=await installationPaths(root,'source');
  if (await currentState(selected.state)) throw new Error('Stop the source instance before refreshing its dependencies.');
  const npm = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!await info(npm)) throw new Error('Source setup requires the npm CLI accompanying your Node installation. Binary users need no npm.');
  run(process.execPath, [npm, 'ci', '--ignore-scripts', '--include=optional', '--no-audit', '--no-fund']);
  run(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json']);
  run(process.execPath, [path.join(root, 'scripts', 'build-windows-host.mjs')]);
  const { defaultShell } = await import('../../dist/platform/shell.js');
  const config = JSON.parse(await readFile(path.join(root, 'config.example.json'), 'utf8'));
  config.runtime.shell = defaultShell(); config.runtime.cwd = root;
  // Generated executables live in .runtime/bin; use separate DACL-protected
  // runtime directories rather than attempting to change the checkout's ACL.
  config.runtime.state_dir = '.runtime/state'; config.runtime.logs_dir = '.runtime/logs';
  if (values['local-only']) config.tunnel.enabled = false;
  for (const [name, content] of [
    ['config.json', JSON.stringify(config, null, 2) + '\n'],
    ['runtime.env', '# Private local credentials. Never share or commit.\nCONTROL_PLANE_TUNNEL_ID=\nCONTROL_PLANE_API_KEY=\nNO_PROXY=localhost,127.0.0.1,::1\n']
  ]) {
    const file = path.join(root, name);
    if (!await info(file)) { await security(helper, 'private-file', file); await writeFile(file, content, { flag: 'r+' }); }
    else { await security(helper, 'validate-private', file); console.log('Preserved: ' + file); }
  }
  if (!values['local-only']) run(process.execPath, ['dist/launcher/cli.js', 'tunnel-setup', '--build']);
}
if (!values['no-global-command']) {
  const names=[];
  for(const name of requested){
    try{await commandConflict(bin,name,old);names.push(name)}
    catch(e){if(name==='mdr'&&!values['commands-only']&&!values.name)console.log('Skipped short command: '+e.message);else throw e}
  }
  await security(helper, 'private-dir', bin);
  const commands = { ...(old?.commands ?? {}) };
  for (const name of names) {
    const file = path.join(bin, name + '.exe');
    if (!await info(file)) await cp(helper, file, { errorOnExist: true, force: false });
    commands[name + '.exe'] = await hash(file);
    console.log('Registered: ' + file);
  }
  await atomicJson(manifest, { project, schema_version: 1, kind: 'source', root, node: process.execPath, commands });
  console.log('Command directory (add to your user PATH when not already present): ' + bin);
}
console.log('Windows source setup complete. No running instance was started or replaced.');
