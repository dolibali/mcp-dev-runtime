# Release procedure

## Precompiled stable releases

The Windows-capable release workflow requires six native platform archives: the original four macOS/Linux tarballs plus Windows x64/ARM64 ZIPs, followed by `SHA256SUMS` and `VERIFICATION.json`. Existing v1.1.0 assets remain four-platform releases. Do not upload a maintainer working directory, credentials or cached binaries. Each production builder uses the pinned official Node archive, locked production dependencies and a clean pinned Tunnel checkout.

The project explicitly approves only the already-pinned `node-pty@1.1.0` install scripts through npm's `allowScripts` policy, so npm versions that default-deny dependency scripts still build the POSIX addon. Windows installations continue using `--ignore-scripts`, which does not run those scripts; no global approval policy is changed.

1. Review changes, run source regressions and binary-package validation, and bump the project version with `npm version VERSION --no-git-tag-version`. Keep `.node-version` and `release-toolchain.lock.json` consistent; do not change Tunnel pins unless deliberately reviewed.
2. Update the bilingual installation docs and `docs/releases/vVERSION.md`. Commit normally and push the reviewed source. The release builder refuses a dirty checkout; `--allow-dirty` is only for local package testing and cannot pass the release aggregator.
3. Run the **Precompiled release** workflow on that exact commit with `create_draft=true`. Original macOS/Linux jobs are retained; separate `windows-2025` x64 and `windows-11-arm` ARM64 jobs compile native components and verify extracted ZIPs. All six native jobs must pass; do not downgrade an ARM64 failure to an untested release artifact. Jobs do not receive user Tunnel credentials.
4. Inspect the six archives, checksums, verification report, tag target and release notes, then publish. Windows verification reports bind the actual ZIP SHA-256. Never overwrite published assets/tags to fix a defect.

The `MDR_SIGNING_MODE=skip` setting intentionally omits publisher signing and Apple notarization for v1.1.0. `scripts/release/sign.mjs` is the reserved boundary before the manifest/archive hashes are generated; any other mode currently fails closed. A future signer must be reviewed and supplied through protected release credentials. GitHub build provenance is separate from OS signing.

Binary acceptance extracts the exact archive into paths containing spaces/Unicode, installs with system Node/npm/Go/compiler/download commands unavailable, exercises all six tools, validates stdio and managed lifecycle (with an explicitly mocked Tunnel), protects active upgrades, checks idempotence/foreign-command conflicts, and tests version switching using a synthetic prior package. It separately verifies the actual bundled Tunnel executable against its recorded hash. It does not claim a real ChatGPT/cloud connection on every runner.

Source export below remains a maintainer audit/development option, not a primary v1 release attachment. npm publication is still intentionally disabled.

## Source export reference

Installation and deployment: [English](../README.md) | [简体中文](README.zh-CN.md). Keep the two README versions aligned when commands, defaults or compatibility boundaries change.

The source is Apache-2.0. Preserve root LICENSE/NOTICE and applicable third-party notices. A public GitHub repository is separate from npm publication and from publishing an app in a hosted marketplace.

## Before the first GitHub push

The README clone examples target `dolibali/mcp-dev-runtime`. When publishing a fork, update both languages to its actual owner/name. Do not invent issue, CI badge or npm registry addresses before those resources exist. An empty remote repository avoids an unnecessary first-push history conflict with an independently generated README/license.

Review what will be uploaded **before** staging or committing. These commands are inspection only:

```bash
git status --short
git diff --stat
git diff --cached --stat
git diff --cached
git ls-files -- config.json launcher.config.json runtime.env .runtime .mcp-dev-runtime
git submodule status vendor/tunnel-client
```

The private-path `git ls-files` check should be empty; inspect any reported files rather than assuming `.gitignore` removes already-tracked data. Also review earlier commits for secrets. A source export check does not scan the entire Git history. If a credential was committed, revoke/rotate it and resolve the history exposure before publication; deleting it only from the latest version is insufficient.

Inspect local paths, labels and reports for private information. Default exclusions do not automatically cover a custom history directory or arbitrarily named credential/backup files. Stage only reviewed source files, including `.gitignore`, public examples, documentation, license notices, `.gitmodules`, and the pinned `vendor/tunnel-client` gitlink. Do not replace the submodule with a nested copy of local binaries or credentials.

Configure a private vulnerability-reporting channel on the destination repository before telling users to report security issues there. GitHub source publication does not grant access to the maintainer's computer, and users need their own runtime and credentials. Private Tunnel connections are not a public marketplace deployment; see the [official Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

## Validate and inspect the source package

Before publishing, run:

```bash
npm ci --include=dev
npm run test:all
npm run verify:cli
npm run release:check
COPYFILE_DISABLE=1 npm run release:source
```

The environment prefix prevents Apple's tar from adding AppleDouble `._*` resource-fork metadata files. It is unnecessary for GNU tar but harmless to pass. Inspect the selected files and generated archive. Private reports, `.runtime/`, local config, dotenv credentials, archives under `artifacts/`, installed dependencies and compiled outputs are excluded. An empty `reports/.gitkeep` may remain as a directory placeholder. `.env.example` is intentionally included and must contain placeholders only. Static path/key checks are a final guard, not a comprehensive security review.

The exporter also excludes the default `.mcp-dev-runtime/` history directory. Do not publish while relying on that default to protect a custom location. Run the validation sequence from a stopped development checkout or disposable copy; do not replace dependencies underneath active work in a production service.

Inspect the generated archive without extracting it over your working tree:

```bash
VERSION=$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json","utf8")).version')
ARCHIVE="artifacts/mcp-dev-runtime-${VERSION}-source.tar.gz"
tar -tzf "$ARCHIVE"
tar -xOf "$ARCHIVE" "mcp-dev-runtime-${VERSION}/SOURCE_MANIFEST.json"
cat "${ARCHIVE}.sha256"
```

The checksum file names the archive by basename, so verify from its containing directory. On macOS:

```bash
(cd artifacts && shasum -a 256 -c "mcp-dev-runtime-${VERSION}-source.tar.gz.sha256")
```

On Linux:

```bash
(cd artifacts && sha256sum -c "mcp-dev-runtime-${VERSION}-source.tar.gz.sha256")
```

These examples use the `VERSION` set above. Keep the checksum and archive together if moving them.

The optional submodule must have a public upstream URL and the exact gitlink declared in `tunnel.lock.json`. Do not replace it with a machine-specific local clone URL. Source exports do not include upstream binaries or a local dependency tree. Users may reuse compatible installed binaries or explicitly build the locked upstream source.

Release notes must distinguish executed local tests, CI configuration, CI actually run on GitHub, real Tunnel readiness, and hosted-client tool calls. Mock Tunnel tests only test lifecycle coordination. No model is called by the test suite.

Package `private: true` prevents accidental registry publication and does not prevent source distribution. Set an available npm scope/name, repository URL and issue tracker only after choosing the owner's actual destination. Do not invent those metadata values. No GitHub push, repository creation or npm publication is performed by the export scripts.

## Automation and distribution boundaries

GitHub Actions CI retains Ubuntu and macOS regression jobs and adds separate Windows x64/ARM64 jobs. Windows uses `npm ci --ignore-scripts --include=optional`, the pinned Go OS adapter, native Go tests and `npm run test:windows`; this includes the original platform-neutral output/retry tests plus Windows behavior tests, not a claim that POSIX-shell fixtures run unchanged under PowerShell. Native image dependencies are verified from the actual package. The manual source-package workflow does not publish a public release. See [Windows development](WINDOWS.md).
