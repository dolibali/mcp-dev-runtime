# Changelog

## Unreleased

- Add `paths [--json]` to show only the package/config/state/log paths actually resolved for the current installation, keeping the command compatible with future distribution layouts.
- Make `status` concise and human-readable by default, add `status --verbose` for operational detail, and preserve the previous complete object behind `status --json`.
- Add the `mdr` convenience command while retaining `mcp-dev-runtime` as canonical. Normal setup auto-registers `mdr` only when conflict-free and otherwise skips just the short alias; explicit command-only registration remains strict. Command-only removal selects one name and never removes another tool.
- Document diagnostic log locations, custom state directories, rotation-aware viewing, error searches with context, missing/empty log behavior and the distinction between service logs and captured execution history in both READMEs.
- Register a user-level `mcp-dev-runtime` command during setup, with an opt-out and standalone command-only install/remove operations. Preserve unrelated commands and report missing PATH entries; do not edit shell profiles or duplicate services.
- Add global `doctor` and configuration-aware `smoke` subcommands. Resolve explicit path arguments from the caller while keeping managed configuration and working-directory bases attached to the installation; preserve local `serve`/stdio caller-directory behavior.

## 0.3.0 — 2026-09-20

### Added and changed

- Disable default time-based session eviction; retain bounded count/byte quotas and independently configured maintenance.
- Separate retry TTL and pin command-creation responses while processes are active; release ended process handles and bound retained command previews.
- Add private bounded disk metadata history, explicit opt-in raw output capture, filtered history queries and read-only cross-instance archive retrieval. Interrupted outcomes remain unknown.
- Add bounded UTF-8 tail/literal-search modes without advancing the normal output cursor.
- Add live health probes, richer diagnostics, an offline history-clear command and runtime MCP/Tunnel log rotation with backpressure.
- Keep six tools; extend the tool contract to 3.1. Preserve the locked upstream Tunnel source and executable.
- Reuse the already-pinned official MCP client as a runtime dependency for installed diagnostic scripts; no new dependency version is introduced.
- Add an idempotent one-click setup path (`./install.sh` / `npm run setup`) that installs locked npm dependencies, preserves existing local configuration, reuses or builds the exact pinned Tunnel source, records dependency state privately, and refuses dependency replacement under an apparently active managed runtime.


### Fixed

- Preserve the bounded command-output chunk in `structuredContent.output` as well as the existing text envelope, so structured-only client adapters can read stdout/stderr.
- Declare `output` for normal `exec_command` and `write_stdin` results, including empty chunks; preserve error-only envelopes, actual exit codes and cursor behavior.
- Cover structured-only HTTP clients, stdio output, Unicode continuation, empty output, retries and explicit replay with regression tests. Document the intentional per-response compatibility copy.

## 0.2.0 — 2026-09-20

- Rename the project and primary CLI to MCP Dev Runtime / mcp-dev-runtime; retain the legacy server-only CLI alias.
- Add Apache-2.0 LICENSE, NOTICE, contribution and responsible-use guidance, and recursive exclusion of local reports/configuration.
- Add a foreground/background supervisor with startup health checks, version-pair validation, duplicate-start handling, instance-bound stop and coordinated child cleanup.
- Pin optional OpenAI tunnel-client source to 70bb5a7e1305596f0216d7b18d0b7765d58576d5. Support existing matching clients and explicit local builds of the narrow runtime.
- Keep project, tool-contract and upstream versions independent and bind them through tunnel.lock.json.
- Preserve all six MCP names and input/output schemas. No Agent/model invocation added.
- Add 18 launcher regression cases and Ubuntu/macOS CI configurations. Native Windows remains unsupported.

## 0.1.1

- Add outputSchema to all six tools, including execution and partial-error branches, with protocol regression coverage.

## 0.1.0

- Implement direct shell/PTY, output continuation, patches, images and execution-session lifecycle over HTTP and stdio.
