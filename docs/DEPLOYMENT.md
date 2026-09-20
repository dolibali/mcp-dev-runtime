# Deployment and lifecycle

## Precompiled v1 distribution

For end-user installation use [BINARY_INSTALL.md](BINARY_INSTALL.md) / [中文预编译安装](BINARY_INSTALL.zh-CN.md). v1.0.1 uses one non-secret `config.json` plus private `runtime.env`; the published v1.0.0 keeps its original split configuration. Existing `launcher.config.json + config.json` installations remain supported without automatic migration. Binary packages include Node and Tunnel, so source-oriented npm/build instructions are not run inside an installed binary package.

Binary `init` only creates missing private config files and never copies credentials or starts a service. `paths`, `config`, `tools` and `status` report effective paths/policy without printing credential contents. Publisher signing/notarization are deliberately skipped for v1.0.1.


First-time installation: [English README](../README.md#install) | [中文部署指南](README.zh-CN.md#install). This page is the operational reference for project 1.0.1 / contract 3.1.

For the complete browser-to-terminal walkthrough, including developer mode and where to create keys and copy Tunnel IDs, see [ChatGPT setup](CHATGPT_SETUP.md) / [ChatGPT 新手图文教程](CHATGPT_SETUP.zh-CN.md).

`npm start` runs only the MCP service. `npm run up` manages MCP plus Tunnel when `tunnel.enabled` is true; with `tunnel.enabled: false`, it manages only MCP and requires no Tunnel credentials. Do not run duplicate services on the same ports.

The user-facing configuration is one non-secret `config.json`. Internal runtime/launcher objects remain separate, but users no longer need to maintain two files. Unified configuration paths resolve relative to `config.json`; explicit CLI path overrides resolve from the caller. `up` enforces HTTP transport for managed MCP.

| Setting | Resolution / ownership |
| --- | --- |
| Unified `runtime.cwd`, `runtime.state_dir`, `runtime.logs_dir`, `runtime.env_file`, `tunnel.binary` | Relative to the selected `config.json`. |
| `history.directory` | Relative to the resolved effective `runtime.cwd`; an absolute dedicated directory is recommended for shared deployments. |
| Explicit CLI path flags | Relative to the caller's current directory. |
| Legacy split config | Retains the old runtime/launcher resolution rules; `--launcher-config` remains compatibility-only. |
| Managed MCP child | Launched from the installed package root. |
| stdio child | Launched by the MCP client; use absolute paths rather than assuming the client's working directory. |

`runtime.cwd` is not an access restriction. The HTTP listener has no application-level authentication or sandbox; leave it on `127.0.0.1`, and do not expose it as a public shared service. Use distinct ports, state directories and history directories for concurrent instances. Change `mcp.port` or `tunnel.health_port` when needed; when Tunnel is enabled the two listeners must not collide.

<a id="ports"></a>
## Local ports and changing a conflicting port

| Component | Project default | Configuration field | Address purpose |
| --- | --- | --- | --- |
| MCP runtime | `127.0.0.1:3001` | `mcp.port` | `/mcp` for tools; `/healthz` for runtime health |
| Tunnel health listener | `127.0.0.1:9098` | `tunnel.health_port` | `/readyz` for Tunnel readiness; absent when `tunnel.enabled=false` |

These defaults are configuration choices, not ports reserved for this project. Keep a working installation's settings; changing the numbers alone is not a security or performance improvement. No chosen fixed port guarantees freedom from collisions. The launcher checks for conflicts and refuses to take over an unrelated listener instead of silently selecting a different port.

When a port is genuinely occupied, stop only a duplicate instance you own. Choose unused alternatives by changing `mcp.port` and, when enabled, `tunnel.health_port` in the same `config.json`. For example, 53123 / 53124 are possible local alternatives, not guaranteed-free choices. Keep `mcp.host` at `127.0.0.1`. Managed startup requires a fixed MCP port; `mcp.port: 0` is not supported by `up`.

Before applying changes, inspect active tasks: `down` stops owned commands. Stop the selected managed instance, edit the same `config.json`, then start again. The launcher generates forwarding/probe URLs from `mcp.*`; do not edit a Tunnel ID to change a local port.

`mdr doctor` and `mdr smoke` follow the selected config. The lower-level `npm run smoke -- URL` and `verify:deployed` still operate on explicit URLs. A changed `curl` URL only probes a different address; it does not change any listener.

## Initial setup versus normal startup

Successful setup also registers the current user's command in `~/.local/bin`, unless `--no-global-command` is specified. Existing deployments may run `npm run command:install` without re-running setup or restarting a service. Registration reuses this checkout and its Node executable; it is not another installation and does not edit shell profiles. [English global command guide](../README.md#global-command) / [中文说明](README.zh-CN.md#global-command).

`mdr` is a convenience entry, not a project rename. Normal setup attempts to register it automatically after the canonical command. If any existing `mdr` executable is found on the current PATH, or the destination is occupied by an unrelated entry, setup skips only the short alias and continues successfully with `mcp-dev-runtime`. Manual `npm run command:install -- --name mdr` remains strict and reports the conflict. Remove only the short entry with `npm run command:uninstall -- --name mdr`. [Short command details](../README.md#short-command) / [短命令说明](README.zh-CN.md#short-command).

For management commands (`up`, `down`, `status`, `doctor`, `smoke`, `paths`, `config`, `tools`, `history-clear`), `--config FILE` selects one unified configuration. Explicit CLI path overrides remain caller-relative; paths stored in unified JSON are config-relative. `serve` retains caller-cwd semantics. Legacy `--launcher-config FILE` remains supported without becoming the new default.

The recommended first-run path is `./install.sh` (or `npm run setup`). It installs the locked npm dependencies, builds the runtime, creates local configuration only when absent, then reuses a compatible Tunnel binary or fetches/builds the exact source pinned by `tunnel.lock.json`. Use `--local-only` to omit Tunnel preparation and `--force-tunnel-build` only for a deliberate rebuild. The installer does not install system packages or provision Platform Tunnel records/credentials.

Repeated setup preserves `config.json` and `runtime.env`; if an old `launcher.config.json` already exists it is also preserved untouched and continues to select legacy split mode. A package-lock fingerprint under ignored `.runtime/setup/` lets setup skip redundant `npm ci`.

`npm run tunnel:setup` remains the read-only compatibility check for the selected Tunnel binary; `npm run tunnel:setup -- --build` is the lower-level explicit build command used by the installer. A source build needs Git, `make` and the Go toolchain required by the pinned module. Go is not required for local-only MCP or when a compatible binary is already available.

A one-time `--tunnel-bin` or `--env-file` does not rewrite configuration. Persist their non-secret paths as `tunnel.binary` and `runtime.env_file`; keep credential values in the private env file, never JSON or CLI arguments.

## Foreground and background

```bash
npm run up -- --config config.json --env-file runtime.env
npm run up -- --config config.json --env-file runtime.env --background
npm run status
npm run down
```

A successful `up` reports the managed instance UUID, process IDs, service URLs, runtime version, Tunnel version and binary hash. An existing managed instance is not silently reconfigured; stop it and start again to apply a new config. Manual external services are never automatically adopted or killed.

Keep the same config selection for all lifecycle commands. Prefer storing a custom state directory in `runtime.state_dir`; a temporary override still works:

```bash
npm run up -- --state-dir /absolute/path/to/private-state --env-file runtime.env --background
npm run status -- --state-dir /absolute/path/to/private-state
npm run down -- --state-dir /absolute/path/to/private-state
```

Inspect `running` and `terminating` executions before `down`: shutdown stops the runtime's active commands. A standalone `npm start` process is stopped through its own terminal/owner, not `down`. A stdio process belongs to the launching client.

The private state directory contains a lifecycle lock, a local control socket, state metadata and logs. No credential values are written to the state record. `down` validates the live control instance rather than signalling a PID recovered from disk. Stale locks are removed only when their recorded owner is not alive; port conflicts still require operator resolution. Process crashes do not imply shell sessions are recoverable.

With `tunnel.enabled=true`, the supervisor starts MCP, waits for health, starts the locked Tunnel and waits for `/readyz`. With `false`, it starts only MCP and does not load Tunnel credentials or resolve a Tunnel binary. Child failure leads to coordinated shutdown; no tool command is automatically replayed.

## Recommended diagnostics

```bash
npm run doctor
npm run smoke
```

New installations resolve the single package/user `config.json`. Existing installations with `launcher.config.json` stay in `legacy-split` mode until deliberately migrated. `mdr config` reports which mode is active without printing secrets. `npm run status` remains a concise lifecycle/readiness summary; `--verbose` and `--json` provide details.

`doctor` checks local configuration, toolchains, fresh health and actual discovery/schema consistency for exactly the tools enabled by `tools.allow`, without running user tasks. `--offline` skips connectivity checks. Use `--config FILE` for a custom unified config; `--launcher-config FILE` is legacy compatibility only.

The standalone `--` in `npm run doctor -- --json` separates npm options from script options: npm runs `node scripts/doctor.mjs --json`. It is not optional punctuation to remove when forwarding flags. Plain `npm run doctor` prints a readable pass/attention heading with its report. For JSON consumers, suppress npm's script banner with `npm --silent run doctor -- --json`, or invoke `node scripts/doctor.mjs --json` from the repository root. The `--json` flag belongs to the project script, not npm. See [npm's official run reference](https://docs.npmjs.com/cli/v12/commands/npm-run/).

<a id="direct-probes"></a>
## Optional direct component probes

Only when diagnosing a specific layer, query its endpoint directly. These examples assume the **default ports**; substitute the ports from your configuration after changing them.

```bash
curl --fail --silent --show-error http://127.0.0.1:3001/healthz
curl --fail --silent --show-error http://127.0.0.1:9098/readyz
```

MCP `/healthz` reports runtime identity and resource/storage status. Tunnel `/readyz` is a separate readiness check. These two requests are not replacements for MCP tool discovery or a real client call, and do not need to be repeated as extra setup steps after successful combined diagnostics. With a standalone local MCP instance, there may be no Tunnel process or health listener at all.

Temporary readiness degradation does not restart the runtime or replay a command. An actual child exit still stops the managed pair and reports failure. An unknown result after a lost response must be investigated through session/history lookup rather than blindly repeated.

## Environment

Exported variables take precedence over the optional dotenv file. `--shell-env` allows a login shell to supply missing credentials and normal PATH/proxy configuration. Captured shell startup output is not printed. Separate MCP child environment excludes Tunnel/OpenAI control keys; normal HOME, PATH and toolchain variables remain intact. This is environment hygiene, not a sandbox.

Do not use a secret key as a CLI argument. Keep local credential files outside source exports. `--env-file` accepts data, not a shell script; it does not expand `$HOME`, run command substitutions or source another file.

When a proxy is required, preserve loopback exclusions with `NO_PROXY=localhost,127.0.0.1,::1`. Changing environment variables in another terminal does not modify an already-running process; restart deliberately after checking active tasks. Do not disable TLS verification to suppress certificate failures.

## State, history and diagnostic logs

For the file-by-file directory table and `tail -F` examples, see [README log instructions](../README.md#logs) / [中文日志目录与查看方法](README.zh-CN.md#logs). On a reachable managed instance, plain `mcp-dev-runtime status` / `mdr status` shows the log directory; `status --json` exposes absolute service log paths in `logs[].file`.

`mdr paths` reports only the package/config/state/log locations actually resolved for the current installation. Source-checkout installations therefore show their configured `.runtime` directory. A future npm/global installation can resolve different user-scoped locations without changing this command's semantics.

The default `.runtime/` directory contains supervisor state, locks, a private control socket, Tunnel build caches and diagnostic logs. Disk execution history instead defaults to `.mcp-dev-runtime/history` relative to runtime `cwd`; configuring `.runtime/history` is an explicit deployment choice, not an automatic relocation.

Command previews and raw output are not persisted by default; labels and workdirs still carry private metadata. Use `capture_output=true` on important tasks whose raw output should be archived. Time-based memory eviction is disabled by default, but memory and disk quotas remain. History is single-writer and read-only after recovery; it cannot resume old processes. See [HISTORY_AND_RECOVERY.md](HISTORY_AND_RECOVERY.md).

MCP and Tunnel diagnostic logs rotate during writes using `log_max_bytes` (default 10 MiB) and `log_files` (default 3, including the current file), separately for each stream. The low-volume `launcher.log` still rotates at startup. These are operational logs, not an automatic archive of every tool's stdout/stderr. Do not publish them without review and redaction.

## Platforms

Windows native is explicitly rejected. Linux and macOS use POSIX shells, node-pty and process groups. The default portable example uses `/bin/bash`; use a host-appropriate shell path in local config. PTY and image library installation require compatible native artifacts or the usual compiler toolchain. Tests do not require a graphical session.

## Changing an existing installation

When renaming a checkout, update absolute client/configuration paths; an intentional compatibility symlink is another option. Both CLI aliases remain available. Changing the project display name does not rename a user's ChatGPT application. The six tool names remain unchanged; contract 3.1 adds optional parameters and result fields, so refresh/review the client's cached tool definitions after upgrading.

Changing the MCP process invalidates live execution handles and in-memory retries. Retained disk history remains queryable within its quotas; old records without a confirmed final result become `unknown`. Stop only after checking active work, preserve private configuration/history backups, rebuild from the reviewed source, and verify the version pair before starting again. Do not copy examples over existing configs or assume a rollback supports a newer archive format.
