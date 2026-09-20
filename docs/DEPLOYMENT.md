# Deployment and lifecycle

First-time installation: [English README](../README.md#install) | [中文部署指南](README.zh-CN.md#install). This page is the operational reference for project 0.3.0 / contract 3.1.

For the complete browser-to-terminal walkthrough, including developer mode and where to create keys and copy Tunnel IDs, see [ChatGPT setup](CHATGPT_SETUP.md) / [ChatGPT 新手图文教程](CHATGPT_SETUP.zh-CN.md).

`npm start` runs only the MCP service. `npm run up` manages both MCP and Tunnel. Do not use both on the same ports simultaneously.

The default non-secret launcher configuration is `launcher.config.json` in the installed project. Relative paths in that file are relative to that file. CLI path overrides are resolved from the caller's working directory. The MCP runtime config is independent. `up` enforces HTTP transport because it connects the two local processes using a loopback URL.

| Setting | Resolution / ownership |
| --- | --- |
| Runtime `cwd` | Relative to the runtime process launch directory, not the JSON file location. It must already exist. |
| Runtime `history.directory` | Relative to the resolved runtime `cwd`; an absolute dedicated directory is recommended. |
| Launcher `runtime_config`, `env_file`, `state_dir`, `tunnel_bin` | Relative to the selected launcher JSON file. |
| Launcher path flags | Relative to the caller's current directory. |
| Managed MCP child | Launched from the installed package root. |
| stdio child | Launched by the MCP client; use absolute paths rather than assuming the client's working directory. |

`cwd` is not an access restriction. The HTTP listener has no application-level authentication or sandbox; leave it on `127.0.0.1`, and do not expose it as a public shared service. Use distinct ports, state directories and history directories for concurrent instances. Change the affected runtime `port` or launcher `tunnel_health_port` when needed; the two listeners must not collide.

<a id="ports"></a>
## Local ports and changing a conflicting port

| Component | Project default | Configuration field | Address purpose |
| --- | --- | --- | --- |
| MCP runtime | `127.0.0.1:3001` | Top-level `port` in the runtime JSON | `/mcp` for tools; `/healthz` for runtime health |
| Tunnel health listener | `127.0.0.1:9098` | `tunnel_health_port` in the launcher JSON | `/readyz` for Tunnel readiness; not an MCP endpoint |

These defaults are configuration choices, not ports reserved for this project. Keep a working installation's settings; changing the numbers alone is not a security or performance improvement. No chosen fixed port guarantees freedom from collisions. The launcher checks for conflicts and refuses to take over an unrelated listener instead of silently selecting a different port.

When a port is genuinely occupied, first check that you are not running both `npm start` and `npm run up` against it. Stop only a duplicate instance that you own. If another application needs the port, choose an unused alternative and edit the affected field in the **existing** JSON file, without replacing the rest of your settings. For example, `port: 53123` in `config.json` and `tunnel_health_port: 53124` in `launcher.config.json` are possible local alternatives, not new defaults or guaranteed-free choices. Keep `host` set to `127.0.0.1` and use distinct ports. Managed startup requires a fixed runtime port; `port: 0` is not supported by `up`.

Before applying changes, inspect active tasks: `down` stops owned commands. Stop the selected managed instance, then start it with the same launcher configuration and env-file selection. The launcher generates its MCP forwarding and probe URLs from the selected configuration; do not edit a Tunnel binary or a public Tunnel ID to change a local port. Keep the same Tunnel selected in ChatGPT. Direct local HTTP clients must use the new `/mcp` URL.

`doctor` follows the selected configuration. With the example MCP port above, `smoke` requires `npm run smoke -- http://127.0.0.1:53123/mcp`; `verify:deployed` likewise needs that explicit URL. Those two scripts default to port 3001 and do **not** automatically read runtime JSON. A changed `curl` URL only probes a different address; it does not change any listener. Do not expose `0.0.0.0` or open public inbound ports to resolve a local collision.

## Initial setup versus normal startup

Successful setup also registers the current user's command in `~/.local/bin`, unless `--no-global-command` is specified. Existing deployments may run `npm run command:install` without re-running setup or restarting a service. Registration reuses this checkout and its Node executable; it is not another installation and does not edit shell profiles. [English global command guide](../README.md#global-command) / [中文说明](README.zh-CN.md#global-command).

`mdr` is a convenience entry, not a project rename. Normal setup attempts to register it automatically after the canonical command. If any existing `mdr` executable is found on the current PATH, or the destination is occupied by an unrelated entry, setup skips only the short alias and continues successfully with `mcp-dev-runtime`. Manual `npm run command:install -- --name mdr` remains strict and reports the conflict. Remove only the short entry with `npm run command:uninstall -- --name mdr`. [Short command details](../README.md#short-command) / [短命令说明](README.zh-CN.md#short-command).

For management commands (`up`, `down`, `status`, `doctor`, `smoke`, `history-clear`), the CLI first resolves explicit relative file/directory flags against the caller's directory, then uses the installation root as its working-directory base. This aligns doctor/history with the MCP child already launched from that root. `serve` retains caller-cwd semantics. Paths stored inside launcher JSON still resolve against that JSON file. The global `smoke` command follows the selected runtime configuration; `npm run smoke` remains the lower-level URL-based script.

The recommended first-run path is `./install.sh` (or `npm run setup`). It installs the locked npm dependencies, builds the runtime, creates local configuration only when absent, then reuses a compatible Tunnel binary or fetches/builds the exact source pinned by `tunnel.lock.json`. Use `--local-only` to omit Tunnel preparation and `--force-tunnel-build` only for a deliberate rebuild. The installer does not install system packages or provision Platform Tunnel records/credentials.

Repeated setup preserves `config.json`, `launcher.config.json` and `runtime.env`. A package-lock fingerprint under ignored `.runtime/setup/` lets it skip `npm ci` after a known-good dependency install. If dependencies have to be replaced while the local supervisor state points at a live managed process, setup refuses the refresh rather than changing `node_modules` underneath that process.

`npm run tunnel:setup` remains the read-only compatibility check for the selected Tunnel binary; `npm run tunnel:setup -- --build` is the lower-level explicit build command used by the installer. A source build needs Git, `make` and the Go toolchain required by the pinned module. Go is not required for local-only MCP or when a compatible binary is already available.

A one-time `--tunnel-bin` or `--env-file` does not rewrite launcher configuration. Persist these paths in `launcher.config.json` or pass them again on future starts. Keep credential values in the private env file, not in launcher JSON or CLI arguments. The [README's ChatGPT section](../README.md#chatgpt) explains the separate Platform/workspace setup.

## Foreground and background

```bash
npm run up -- --config config.json --env-file runtime.env
npm run up -- --config config.json --env-file runtime.env --background
npm run status
npm run down
```

A successful `up` reports the managed instance UUID, process IDs, service URLs, runtime version, Tunnel version and binary hash. An existing managed instance is not silently reconfigured; stop it and start again to apply a new config. Manual external services are never automatically adopted or killed.

Keep the same launcher selection for all lifecycle commands. For example, with custom state:

```bash
npm run up -- --state-dir /absolute/path/to/private-state --env-file runtime.env --background
npm run status -- --state-dir /absolute/path/to/private-state
npm run down -- --state-dir /absolute/path/to/private-state
```

Inspect `running` and `terminating` executions before `down`: shutdown stops the runtime's active commands. A standalone `npm start` process is stopped through its own terminal/owner, not `down`. A stdio process belongs to the launching client.

The private state directory contains a lifecycle lock, a local control socket, state metadata and logs. No credential values are written to the state record. `down` validates the live control instance rather than signalling a PID recovered from disk. Stale locks are removed only when their recorded owner is not alive; port conflicts still require operator resolution. Process crashes do not imply shell sessions are recoverable.

The supervisor starts MCP, waits for health, starts the locked Tunnel and waits for `/readyz`. Child failure leads to coordinated shutdown. A transient outbound network outage is handled by Tunnel's own reconnect/poll behavior and does not cause automatic duplicate tool commands. Background mode survives closing the original terminal, but no boot service is installed automatically.

## Recommended diagnostics

```bash
npm run doctor
npm run smoke
```

From the checkout, `doctor` resolves `launcher.config.json` and its runtime config, falling back to the package-local `config.json` when present. `npm run status` is an optional lifecycle check and includes `health.availability`, a checked timestamp and component details; lifecycle `state=ready` alone does not establish current reachability. Default health probes run every five seconds, and sufficiently stale status queries trigger a refresh.

`doctor` checks local configuration, toolchains, fresh health and actual six-tool discovery/schema consistency without running user tasks. `--offline` skips connectivity checks. Neither local readiness nor an SDK test proves the ChatGPT round trip; scan tools and perform a harmless call in the actual client as a separate step. For custom launcher configuration, pass `--launcher-config FILE` to doctor and the lifecycle commands.

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

For the file-by-file directory table and `tail -F` examples, see [README log instructions](../README.md#logs) / [中文日志目录与查看方法](README.zh-CN.md#logs). On a reachable managed instance, `mcp-dev-runtime status` (or registered `mdr status`) exposes absolute service log paths in `logs[].file`.

The default `.runtime/` directory contains supervisor state, locks, a private control socket, Tunnel build caches and diagnostic logs. Disk execution history instead defaults to `.mcp-dev-runtime/history` relative to runtime `cwd`; configuring `.runtime/history` is an explicit deployment choice, not an automatic relocation.

Command previews and raw output are not persisted by default; labels and workdirs still carry private metadata. Use `capture_output=true` on important tasks whose raw output should be archived. Time-based memory eviction is disabled by default, but memory and disk quotas remain. History is single-writer and read-only after recovery; it cannot resume old processes. See [HISTORY_AND_RECOVERY.md](HISTORY_AND_RECOVERY.md).

MCP and Tunnel diagnostic logs rotate during writes using `log_max_bytes` (default 10 MiB) and `log_files` (default 3, including the current file), separately for each stream. The low-volume `launcher.log` still rotates at startup. These are operational logs, not an automatic archive of every tool's stdout/stderr. Do not publish them without review and redaction.

## Platforms

Windows native is explicitly rejected. Linux and macOS use POSIX shells, node-pty and process groups. The default portable example uses `/bin/bash`; use a host-appropriate shell path in local config. PTY and image library installation require compatible native artifacts or the usual compiler toolchain. Tests do not require a graphical session.

## Changing an existing installation

When renaming a checkout, update absolute client/configuration paths; an intentional compatibility symlink is another option. Both CLI aliases remain available. Changing the project display name does not rename a user's ChatGPT application. The six tool names remain unchanged; contract 3.1 adds optional parameters and result fields, so refresh/review the client's cached tool definitions after upgrading.

Changing the MCP process invalidates live execution handles and in-memory retries. Retained disk history remains queryable within its quotas; old records without a confirmed final result become `unknown`. Stop only after checking active work, preserve private configuration/history backups, rebuild from the reviewed source, and verify the version pair before starting again. Do not copy examples over existing configs or assume a rollback supports a newer archive format.
