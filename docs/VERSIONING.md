# Version and compatibility policy

The project, tool contract and upstream Tunnel have different release boundaries. Their versions are not forced to match.

| Identity | Source of truth | Purpose |
| --- | --- | --- |
| Project version | `package.json` and npm lock | Runtime/launcher release, currently 0.3.0 |
| Tool contract | `CONTRACT_VERSION`, tool JSON | Observable tool behavior, currently 3.1 |
| Tunnel source version | `tunnel.lock.json` | Upstream informational version, currently 0.0.14 |
| Tunnel source commit | lock + submodule gitlink | Exact compatibility input, currently 70bb5a7… |
| Local binary SHA-256 | build receipt + status | Identify the executable actually used |

Using project version 0.0.14 simply because Tunnel uses 0.0.14 would hide independent fixes and changes. The release notes record the tested pair instead. Updating output metadata, launcher behavior or documentation does not require an upstream release.

## Update procedure

1. Select a fixed upstream release or commit and review upstream changes. Do not depend on a moving default branch.
2. Update `vendor/tunnel-client` to the exact commit; update its gitlink and `tunnel.lock.json` together.
3. Build or obtain the intended binary variant. Record provenance and checksums without claiming local builds are official signed releases.
4. Run runtime, protocol and launcher tests. Check real Tunnel readiness using a dedicated authorized Tunnel, then separately verify hosted tools.
5. Publish the project release with the compatible source version, full SHA, variants and executed platform matrix.

An upstream version string proves what the executable reports, not publisher authenticity. Locally built binaries are identified by source pin and recorded hash. If official prebuilt assets are introduced later, pin URL, version, architecture and a checksum from trusted upstream release metadata; verify platform signing requirements. No such unverified automatic download is part of 0.2.0.

## Submodule versus source archive

Git checkouts use a pinned optional submodule. Source archives include `.gitmodules` and the lock but not upstream source; `tunnel-setup --build` can obtain the same commit into an ignored cache. Installed compatible binaries do not require a source checkout. Changes in the upstream default branch never automatically change the installed runtime.

## Breaking changes

Record all changes to tool names, argument semantics, result meanings, CLI defaults and retained process behavior. Before 1.0, minor versions can contain breaking changes but must include migration notes. Fixes without intentional contract changes use a patch release. This is the project's policy, not a claim about upstream's release rules.

## Routine project version bump

```bash
npm version patch --no-git-tag-version
npm run release:check
```

The npm version lifecycle calls `scripts/sync-version.mjs`. It updates the project association in `tunnel.lock.json` after npm updates package.json/package-lock.json, but does not move the upstream commit or tool-contract version. `npm run versions:sync` is available for deliberate manual metadata updates. No Git tag, commit or upstream upgrade is created by this helper. Startup rejects an inconsistent project/lock pair rather than guessing compatibility.
