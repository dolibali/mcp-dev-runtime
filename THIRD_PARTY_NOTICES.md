# Third-party reference and dependencies

Codex reference repository: https://github.com/openai/codex

Pinned source commit: `78245b47af2a7aafcabe025828ceecca69db4df1`.

The public tool vocabulary, custom patch grammar and matching sequence were consulted when implementing this independent TypeScript service. The reference is not a runtime dependency; no Codex executable, Agent, SDK or App Server is invoked. The upstream license is retained in `reference/codex/LICENSE`. The retrieved reference files and provenance are listed in `reference/codex/SOURCE.json`.

Runtime and development dependency licenses are included with their installed npm packages. Exact dependency versions and package integrity values are recorded in package-lock.json. MCP Dev Runtime is distributed under Apache-2.0. The npm package remains private to prevent accidental registry publication, independently of the source license.

## Optional OpenAI Secure MCP Tunnel

Repository: https://github.com/openai/tunnel-client

Pinned source commit: `70bb5a7e1305596f0216d7b18d0b7765d58576d5`. The optional Git submodule is `vendor/tunnel-client`. The launcher may use the full CLI or the narrow run-only runtime from this pin. Upstream source, LICENSE and any applicable NOTICE remain under upstream terms. Locally built artifacts are not official signed releases. See `tunnel.lock.json`.

### Official onboarding reference images

The three PNG files in `docs/images/openai/` are unmodified copies of `docs/images/tunnel-create-modal.png`, `docs/images/tunnel-permissions-role.png`, and `docs/images/chatgpt-connector-tunnel-select.png` from the OpenAI tunnel-client repository at the source commit above. They are upstream documentation illustrations, not screenshots of this project's maintainer account or a claim that every current account has the same interface. The source is distributed under Apache-2.0; attribution and exact source links are in `docs/images/openai/README.md`. The upstream `LICENSE` and `NOTICE` are retained in that directory.
