import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile, chmod, realpath, rm, lstat, readdir } from 'node:fs/promises';
import { tmpdir, release as osRelease } from 'node:os';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { digest, inventory } from './bundle-lib.mjs';
import { signBundle } from './sign.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({ options: { 'allow-dirty': { type: 'boolean' } } });
process.chdir(root);
const run = (cmd, args, cwd = root, env = process.env) => execFileSync(cmd, args, { cwd, env, stdio: 'inherit', timeout: 20 * 60 * 1000 });
const capture = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout: 60000 }).trim();
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const tools = JSON.parse(await readFile('release-toolchain.lock.json', 'utf8'));
const tunnelLock = JSON.parse(await readFile('tunnel.lock.json', 'utf8'));
const target = process.platform + '-' + process.arch;
const expectedHash = tools.node_archives[target];
if (!expectedHash) throw new Error('Unsupported release platform: ' + target);
if (tunnelLock.runtime_version !== pkg.version) throw new Error('Project/Tunnel lock mismatch.');
const dirty = !!capture('git', ['status', '--porcelain', '--untracked-files=normal']);
if (dirty && !values['allow-dirty']) throw new Error('Release builds require a clean Git checkout. --allow-dirty is for local testing only.');
const commit = capture('git', ['rev-parse', 'HEAD']);
const work = await mkdtemp(path.join(tmpdir(), 'mdr-build-'));
const id = target + (process.platform === 'linux' ? '-gnu' : '');
const basename = `${pkg.name}-${pkg.version}-${id}`;
const bundle = path.join(work, basename), app = path.join(bundle, 'app');
const downloads = path.join(root, '.runtime', 'release-downloads');
await mkdir(downloads, { recursive: true });
const nodeArchiveName = `node-v${tools.node_version}-${target}.tar.gz`;
const nodeArchive = path.join(downloads, nodeArchiveName);
console.log('[release] Building ' + basename + ' from ' + commit + (dirty ? ' (local dirty test)' : ''));
try {
  if (await digest(nodeArchive).catch(() => '') !== expectedHash) {
    const download = nodeArchive + '.partial';
    run('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '3', '--connect-timeout', '20', '--max-time', '600', tools.node_base_url + nodeArchiveName, '--output', download]);
    if (await digest(download) !== expectedHash) throw new Error('Official Node archive checksum mismatch.');
    const { rename } = await import('node:fs/promises'); await rename(download, nodeArchive);
  }
  run('tar', ['-xzf', nodeArchive, '-C', work]);
  const nodeRoot = path.join(work, `node-v${tools.node_version}-${target}`);
  const node = path.join(nodeRoot, 'bin', 'node');
  if (capture(node, ['--version']) !== 'v' + tools.node_version) throw new Error('Pinned Node version check failed.');
  const buildEnv = { ...process.env, PATH: path.join(nodeRoot, 'bin') + path.delimiter + process.env.PATH,
    SHARP_IGNORE_GLOBAL_LIBVIPS: '1', npm_config_audit: 'false', npm_config_fund: 'false' };
  await mkdir(path.join(app, 'scripts', 'release'), { recursive: true });
  // Install production dependencies under the pinned Node; never copy the maintainer's node_modules.
  for (const file of ['package.json', 'package-lock.json']) await cp(path.join(root, file), path.join(app, file));
  await cp(path.join(root, 'scripts', 'prepare-pty.mjs'), path.join(app, 'scripts', 'prepare-pty.mjs'));
  run(node, [path.join(nodeRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'ci', '--omit=dev', '--include=optional'], app, buildEnv);
  run(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json']);
  await cp(path.join(root, 'dist'), path.join(app, 'dist'), { recursive: true });
  for (const file of ['contracts', 'tunnel.lock.json']) await cp(path.join(root, file), path.join(app, file), { recursive: true });
  for (const file of ['doctor.mjs', 'smoke.mjs', 'verify-deployed.mjs']) await cp(path.join(root, 'scripts', file), path.join(app, 'scripts', file));
  for (const file of ['bundle-lib.mjs', 'install.mjs']) await cp(path.join(root, 'scripts', 'release', file), path.join(app, 'scripts', 'release', file));
  for (const file of ['README.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md', 'docs']) await cp(path.join(root, file), path.join(bundle, file), { recursive: true });
  await mkdir(path.join(bundle, 'reference', 'codex'), { recursive: true });
  for(const file of ['LICENSE','SOURCE.json'])await cp(path.join(root,'reference','codex',file),path.join(bundle,'reference','codex',file));
  // The archive landing page is for end users, not the source-build workflow.
  await writeFile(path.join(bundle, 'README.md'), '# MCP Dev Runtime ' + pkg.version + '\n\n' +
    '[English installation](docs/BINARY_INSTALL.md) | [简体中文安装](docs/BINARY_INSTALL.zh-CN.md)\n\n' +
    'This precompiled package includes its own Node runtime, native dependencies and pinned Tunnel. Verify the release SHA256SUMS, then run `./install.sh` without sudo. Publisher signing and Apple notarization are deliberately skipped.\n\n' +
    '运行包已内置 Node、原生依赖及固定版本 Tunnel。先核对 Release 的 SHA256SUMS，再执行 `./install.sh`，不需要 sudo 或编译器。本版暂不进行发布者签名和 Apple 公证。\n\n' +
    '[ChatGPT setup](docs/CHATGPT_SETUP.md) | [ChatGPT 图文教程](docs/CHATGPT_SETUP.zh-CN.md)\n');
  // Any source-only relative documentation link points to the immutable release source instead.
  async function resolveDocLinks(dir) {
    for (const name of await readdir(dir)) {
      const file = path.join(dir, name), info = await lstat(file);
      if (info.isDirectory()) { await resolveDocLinks(file); continue; }
      if (!name.endsWith('.md')) continue;
      let text = await readFile(file, 'utf8');
      const links = [...text.matchAll(/\]\(([^\s)]+)\)/g)];
      for (const match of links) {
        const href = match[1]; if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) continue;
        const [targetPath, anchor] = href.split('#');
        const targetFile = path.resolve(path.dirname(file), decodeURIComponent(targetPath));
        // The short binary landing README intentionally has no source-guide anchors.
        const landingAnchor = anchor && targetFile === path.join(bundle, 'README.md');
        try { await lstat(targetFile); if (!landingAnchor) continue; } catch (e) { if (e.code !== 'ENOENT') throw e; }
        const rel = path.relative(bundle, targetFile).split(path.sep).join('/');
        if (rel.startsWith('../')) continue;
        const replacement = `https://github.com/dolibali/mcp-dev-runtime/blob/v${pkg.version}/${rel}` + (anchor ? '#' + anchor : '');
        text = text.replaceAll('](' + href + ')', '](' + replacement + ')');
      }
      await writeFile(file, text);
    }
  }
  await resolveDocLinks(path.join(bundle, 'docs'));
  await mkdir(path.join(bundle, 'licenses'), { recursive: true });
  await cp(path.join(nodeRoot, 'LICENSE'), path.join(bundle, 'licenses', 'NODE-LICENSE'));
  await mkdir(path.join(bundle, 'runtime'), { recursive: true });
  await cp(node, path.join(bundle, 'runtime', 'node')); await chmod(path.join(bundle, 'runtime', 'node'), 0o755);
  // Runtime source-map/declaration files are not needed by end users.
  async function pruneTypes(dir) {
    for (const name of await readdir(dir)) {
      const file = path.join(dir, name), s = await lstat(file);
      if (s.isDirectory()) await pruneTypes(file);
      else if (name.endsWith('.map') || name.endsWith('.d.ts')) await rm(file);
    }
  }
  await pruneTypes(path.join(app, 'dist'));
  const prebuilds = path.join(app, 'node_modules', 'node-pty', 'prebuilds');
  for (const name of await readdir(prebuilds).catch(() => [])) if (name !== target) await rm(path.join(prebuilds, name), { recursive: true });
  // node-gyp intermediates can contain absolute build paths; retain only runtime files.
  const nativeBuild = path.join(app, 'node_modules', 'node-pty', 'build');
  const nativeKeep = path.join(work, 'pty-runtime'); await mkdir(nativeKeep);
  for (const name of ['pty.node', 'spawn-helper']) {
    const from = path.join(nativeBuild, 'Release', name);
    try { await cp(from, path.join(nativeKeep, name)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  await rm(nativeBuild, { recursive: true, force: true });
  if ((await readdir(nativeKeep)).length) await cp(nativeKeep, path.join(nativeBuild, 'Release'), { recursive: true });
  await rm(path.join(app, 'node_modules', '.package-lock.json'), { force: true });
  await rm(path.join(app, 'package-lock.json'));
  // Installed npm metadata does not advertise source-only scripts.
  const metadata = { name: pkg.name, version: pkg.version, type: 'module', private: true, description: pkg.description,
    license: pkg.license, engines: pkg.engines, dependencies: pkg.dependencies, bin: pkg.bin };
  await writeFile(path.join(app, 'package.json'), JSON.stringify(metadata, null, 2) + '\n');

  const source = path.join(work, 'tunnel-source');
  run('git', ['clone', '--filter=blob:none', '--no-checkout', tunnelLock.upstream.repository, source]);
  run('git', ['fetch', 'origin', tunnelLock.upstream.commit], source);
  run('git', ['checkout', '--detach', tunnelLock.upstream.commit], source);
  if (capture('git', ['rev-parse', 'HEAD'], source) !== tunnelLock.upstream.commit) throw new Error('Tunnel source pin mismatch.');
  if (capture('go', ['env', 'GOVERSION'], source) !== 'go' + tools.go_version) throw new Error('Tunnel build toolchain differs from release-toolchain.lock.json.');
  run('make', ['tunnel-client-runtime'], source, { ...buildEnv, CGO_ENABLED: '0', GOOS: process.platform, GOARCH: process.arch === 'x64' ? 'amd64' : process.arch });
  await mkdir(path.join(bundle, 'tunnel'));
  const tunnel = path.join(bundle, 'tunnel', 'tunnel-client-runtime');
  await cp(await realpath(path.join(source, 'bin', 'tunnel-client-runtime')), tunnel); await chmod(tunnel, 0o755);
  const reported = capture(tunnel, ['--version']);
  if (!reported.includes(tunnelLock.upstream.source_version) || !reported.includes(tunnelLock.upstream.commit.slice(0, 7))) throw new Error('Built Tunnel identity mismatch.');
  const tunnelHash = await digest(tunnel);
  for (const file of ['LICENSE', 'NOTICE']) {
    try { await cp(path.join(source, file), path.join(bundle, 'licenses', 'TUNNEL-' + file)); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  // Go dependency inventory accompanies the binary; full module license files are copied too.
  const goModulesText = capture('go', ['list', '-m', '-json', 'all'], source);
  const goModules = JSON.parse('[' + goModulesText.trim().replace(/}\s*\{/g, '},{') + ']');
  const dependencyLicenses = path.join(bundle, 'licenses', 'go'); await mkdir(dependencyLicenses, { recursive: true });
  const goList = [];
  for (const mod of goModules) {
    goList.push({ name: mod.Path, version: mod.Version ?? tunnelLock.upstream.commit });
    if (!mod.Dir) continue;
    const safeName = mod.Path.replaceAll('/', '_');
    for (const name of await readdir(mod.Dir)) if (/^(licen[cs]e|copying|notice|copyright)([._-]|$)/i.test(name)) {
      const file = path.join(mod.Dir, name); if (!(await lstat(file)).isFile()) continue;
      await mkdir(path.join(dependencyLicenses, safeName), { recursive: true });
      await cp(file, path.join(dependencyLicenses, safeName, name));
    }
  }
  await writeFile(path.join(bundle, 'licenses', 'GO-MODULES.json'), JSON.stringify(goList, null, 2) + '\n');
  const distribution = { schema_version: 1, kind: 'binary', version: pkg.version, platform: process.platform,
    arch: process.arch, node_version: tools.node_version, tunnel_sha256: tunnelHash };
  await writeFile(path.join(app, 'distribution.json'), JSON.stringify(distribution, null, 2) + '\n');
  await mkdir(path.join(bundle, 'bin'));
  const wrapper = '#!/bin/sh\nset -eu\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec "$ROOT/runtime/node" "$ROOT/app/dist/launcher/cli.js" "$@"\n';
  for (const name of ['mdr', 'mcp-dev-runtime']) await writeFile(path.join(bundle, 'bin', name), wrapper, { mode: 0o755 });
  const install = '#!/bin/sh\nset -eu\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\n' +
    `case "$(uname -s):$(uname -m)" in ${process.platform === 'darwin' ? 'Darwin' : 'Linux'}:${process.arch === 'arm64' ? (process.platform === 'darwin' ? 'arm64' : 'aarch64|Linux:arm64') : 'x86_64'}) ;; *) echo "Wrong platform/architecture. Download ${id}." >&2; exit 1;; esac\n` +
    'exec "$ROOT/runtime/node" "$ROOT/app/scripts/release/install.mjs" "$@"\n';
  await writeFile(path.join(bundle, 'install.sh'), install, { mode: 0o755 });
  // SPDX inventory: production npm packages + Node + the pinned Tunnel.
  const npmLock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const packages = [];
  for (const [rel, entry] of Object.entries(npmLock.packages)) {
    if (!rel || entry.dev) continue;
    try { await lstat(path.join(app, rel, 'package.json')); } catch { continue; }
    const dep = JSON.parse(await readFile(path.join(app, rel, 'package.json'), 'utf8'));
    const id = 'SPDXRef-' + createHash('sha256').update(rel).digest('hex').slice(0, 20);
    packages.push({ SPDXID: id, name: dep.name, versionInfo: dep.version, downloadLocation: entry.resolved ?? 'NOASSERTION',
      filesAnalyzed: false, licenseConcluded: 'NOASSERTION', licenseDeclared: typeof dep.license === 'string' ? dep.license : 'NOASSERTION', copyrightText: 'NOASSERTION' });
  }
  for (const [name, version] of [['node', tools.node_version], ['tunnel-client-runtime', tunnelLock.upstream.commit]]) packages.push({
    SPDXID: 'SPDXRef-' + name, name, versionInfo: version, downloadLocation: name === 'node' ? tools.node_base_url + nodeArchiveName : tunnelLock.upstream.repository,
    filesAnalyzed: false, licenseConcluded: 'NOASSERTION', licenseDeclared: name === 'node' ? 'MIT' : 'Apache-2.0', copyrightText: 'NOASSERTION' });
  const created = new Date().toISOString();
  await writeFile(path.join(bundle, 'SBOM.spdx.json'), JSON.stringify({ spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0', SPDXID: 'SPDXRef-DOCUMENT',
    name: basename, documentNamespace: `https://github.com/dolibali/mcp-dev-runtime/sbom/${commit}/${target}`, creationInfo: { created, creators: ['Tool: mcp-dev-runtime-release'] },
    packages, relationships: packages.map(p => ({ spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: p.SPDXID })) }, null, 2) + '\n');
  const signing = await signBundle(bundle);
  const manifest = { schema_version: 1, project: pkg.name, version: pkg.version, source_commit: commit, dirty,
    platform: process.platform, arch: process.arch, build_os: osRelease(), tested_baseline: tools.minimum_tested_platforms[target], created_at: created,
    node: { version: tools.node_version, archive: nodeArchiveName, archive_sha256: expectedHash },
    tunnel: { repository: tunnelLock.upstream.repository, commit: tunnelLock.upstream.commit, reported_version: reported, sha256: tunnelHash },
    signing, files: await inventory(bundle, { normalize: true }) };
  await writeFile(path.join(bundle, 'BUILD-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
  const checkHome = path.join(work, 'check-home'); await mkdir(checkHome);
  const checkEnv = { ...buildEnv, HOME: checkHome, XDG_CONFIG_HOME: path.join(checkHome, 'config'), XDG_STATE_HOME: path.join(checkHome, 'state'),
    XDG_DATA_HOME: path.join(checkHome, 'data'), XDG_CACHE_HOME: path.join(checkHome, 'cache'), TUNNEL_BIN: '', NODE_OPTIONS: '' };
  run(path.join(bundle, 'runtime', 'node'), ['--version'], work, checkEnv);
  run(path.join(bundle, 'bin', 'mcp-dev-runtime'), ['--version'], work, checkEnv);
  run(path.join(bundle, 'bin', 'mcp-dev-runtime'), ['tunnel-setup'], work, checkEnv);
  await mkdir(path.join(root, 'artifacts'), { recursive: true });
  const archive = path.join(root, 'artifacts', basename + '.tar.gz');
  run('tar', ['-czf', archive, '-C', work, basename], root, { ...process.env, COPYFILE_DISABLE: '1' });
  await writeFile(archive + '.sha256', await digest(archive) + '  ' + path.basename(archive) + '\n');
  console.log('[release] Created ' + archive);
} finally { await rm(work, { recursive: true, force: true }); }
