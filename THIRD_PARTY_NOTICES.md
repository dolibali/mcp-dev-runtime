# Third-party reference and dependencies

Codex reference repository: https://github.com/openai/codex

Pinned source commit: `78245b47af2a7aafcabe025828ceecca69db4df1`.

The public tool vocabulary, custom patch grammar and matching sequence were consulted when implementing this independent TypeScript service. The reference is not a runtime dependency; no Codex executable, Agent, SDK or App Server is invoked. The upstream license is retained in `reference/codex/LICENSE`. The retrieved reference files and provenance are listed in `reference/codex/SOURCE.json`.

Runtime and development dependency licenses are included with their installed npm packages. Exact dependency versions and package integrity values are recorded in package-lock.json. MCP Dev Runtime is distributed under Apache-2.0. The npm package remains private to prevent accidental registry publication, independently of the source license.

## Skill metadata parser

The opt-in Skill module uses `yaml` 2.9.1 by Eemeli Aro and contributors (ISC license),
https://github.com/eemeli/yaml. It is loaded lazily only when a Skill tool is invoked.
Its license ships with the installed production package and is inventoried in the
precompiled bundle. The lockfile records the exact package integrity.

The Skill design was compared with public Codex source at commit
`5c5308fc9a9ee789049d646ef11e5400384b9c6f`. This is a separate design reference,
not a change to the existing patch-engine reference pin and not a runtime dependency.
No Codex executable, agent or model is invoked by Skill discovery/reading.

## Windows OS adapter (unreleased)

The Windows-only `mdr-windows-host` is independently implemented Go/Win32 code.
It uses `golang.org/x/sys` v0.45.0 (Go Authors, BSD-3-Clause), pinned by
`native/windows-host/go.mod` and `go.sum`. Windows bundles retain the dependency
license under `licenses/go/` and the Go toolchain license as `licenses/GO-LICENSE`.
Public Codex process/console architecture at commit
`a2de8fedcc3abe3cdde09b43515db820fb6b95b5` was consulted; no Codex executable,
sandbox, agent or model API is invoked. POSIX node-pty remains pinned unchanged.

## Optional OpenAI Secure MCP Tunnel

Repository: https://github.com/openai/tunnel-client

Pinned source commit: `70bb5a7e1305596f0216d7b18d0b7765d58576d5`. The optional Git submodule is `vendor/tunnel-client`. The launcher may use the full CLI or the narrow run-only runtime from this pin. Upstream source, LICENSE and any applicable NOTICE remain under upstream terms. Locally built artifacts are not official signed releases. See `tunnel.lock.json`.

### Official onboarding reference images

The three PNG files in `docs/images/openai/` are unmodified copies of `docs/images/tunnel-create-modal.png`, `docs/images/tunnel-permissions-role.png`, and `docs/images/chatgpt-connector-tunnel-select.png` from the OpenAI tunnel-client repository at the source commit above. They are upstream documentation illustrations, not screenshots of this project's maintainer account or a claim that every current account has the same interface. The source is distributed under Apache-2.0; attribution and exact source links are in `docs/images/openai/README.md`. The upstream `LICENSE` and `NOTICE` are retained in that directory.

## Precompiled v1 distributions

Precompiled archives include a pinned official Node.js runtime and its complete LICENSE, a locally built runtime-only Tunnel and its LICENSE/NOTICE plus Go module license inventory, and production npm packages with their installed licenses. `SBOM.spdx.json` inventories the shipped npm packages, Node and Tunnel; `licenses/GO-MODULES.json` records the Go module graph. `BUILD-MANIFEST.json` identifies the exact source commit, toolchain and file hashes. Publisher signing and Apple notarization are explicitly skipped in v1.0.0. This does not claim the embedded Node or Go binaries are devoid of upstream/ad-hoc signatures.
