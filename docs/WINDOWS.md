# Windows native installation and development

This describes the **unreleased Windows implementation**, not an update to the
published v1.1.0 assets. Windows x64 and ARM64 use separate native ZIP packages.
An ARM64 cross-build alone is not runtime verification: the release workflow
requires a matching `windows-11-arm` runner to pass before publishing that asset.

## Runtime package

The Windows ZIP contains pinned Node, production JavaScript dependencies, Sharp's
matching native image module, the pinned Tunnel, and `mdr-windows-host.exe`.
End users do not need Node, npm, Go, Python, MSVC, Git Bash, WSL or administrator
elevation to run the package. Git and ripgrep remain optional development tools;
`mdr doctor` reports whether they are available.

Verify the release's SHA-256 checksum, extract the matching ZIP, and run from
PowerShell:

```powershell
.\install.ps1
```

Use normal organization-approved script execution policies. The installer does
not set ExecutionPolicy, bypass policy, disable antivirus, change the firewall,
install a service or request elevation. Publisher signing is currently skipped.

The long command is registered; `mdr.exe` is registered only when it does not
conflict with an existing command. The installer prints the command directory.
Add it to your **user** Path when necessary and open a new terminal; system Path
and shell profiles are not modified automatically. Until then, use the full path:

```powershell
& "$env:LOCALAPPDATA\Programs\mcp-dev-runtime\bin\mdr.exe" paths
```

## User directories and configuration

| Contents | Default location |
| --- | --- |
| Unified configuration and private `runtime.env` | `%LOCALAPPDATA%\mcp-dev-runtime` |
| Supervisor state and default history | `%LOCALAPPDATA%\mcp-dev-runtime\state` |
| Diagnostic logs | `%LOCALAPPDATA%\mcp-dev-runtime\logs` |
| Cache | `%LOCALAPPDATA%\mcp-dev-runtime\cache` |
| Versioned application files | `%LOCALAPPDATA%\Programs\mcp-dev-runtime\releases` |
| Native command entries | `%LOCALAPPDATA%\Programs\mcp-dev-runtime\bin` |

New private directories have explicit Windows DACLs. Existing unsafe directories
are refused rather than recursively changing their permissions. Reparse points
in private state/configuration paths are rejected. Shared Skill directories are
not installation data and are never deleted by MDR uninstall.

`config.json` remains the single non-secret configuration; `runtime.env` contains
credentials. Defaults remain MCP port 3001 and Tunnel health port 9098. Setting
`tunnel.enabled` to false runs local MCP without Tunnel credentials.

```powershell
mdr config
mdr tools
mdr start --bg
mdr status
mdr doctor
mdr smoke
mdr restart --bg
mdr stop
```

Review active tasks before restart/stop. `up`, `down` and `--background` remain
compatible aliases. Native named-pipe control uses an instance token; the CLI
does not terminate an arbitrary PID recovered from a stale state file.

## Shell and execution semantics

PowerShell 7 is selected when found, otherwise Windows PowerShell 5.1 is used.
The model is told which shell is selected. PowerShell 5.1 does **not** support
PowerShell 7's `&&`/`||`; use its native syntax. Do not send Bash commands to a
PowerShell session. Explicitly installed Bash/Sh/Zsh executables can be selected;
`cmd.exe` and batch files can be invoked from PowerShell, not used as MDR's direct
shell backend in this version.

UTF-8 output is requested. Explicit exits and the final failing native program's
exit code are preserved; scripts that deliberately recover from an earlier
failure retain normal shell semantics. Some old native programs still emit an
OEM code page and must be configured by the caller; MDR does not guess encodings.

Ordinary executions use pipes; `tty=true` uses ConPTY. Tool output is raw terminal
text when appropriate (including ANSI sequences). Each execution is created
suspended, assigned to its own Job Object, then resumed. No task is started if
containment fails. A completed task does not leave detached descendants running;
long-lived services should keep their execution session alive.

Windows has no POSIX signal equivalence. Graceful terminal cancellation sends
Ctrl-C, while forced termination uses the owned Job. Pipe termination is a Job
termination. `signal` is not fabricated as a Unix signal. Final state is reported
only after process/output handling completes. Managed MCP shutdown uses a
private inherited control channel so history can flush before exit.

The control reader is independent of child input writes. A program that never
reads stdin cannot block forced cancellation or parent-disconnect cleanup.
Pending input is bounded; exceeding the bound fails explicitly rather than
silently dropping input. Lifecycle waiting uses monotonic elapsed time, not the
adjustable wall clock; status/history timestamps remain ordinary date-times.

## Upgrade, rollback and removal

Stop MDR, then run the new ZIP's `install.ps1`. Existing settings and older
installed versions are retained. A small atomic `current.json` pointer selects
the version; no junction/symlink privilege is required and loaded executables are
not overwritten. Reinstalling a trusted retained ZIP selects that version again.
An existing version with different contents is rejected.

```powershell
& "$env:LOCALAPPDATA\mcp-dev-runtime\uninstall.ps1"
```

Uninstall lists paths and requires `y`/`Y`; Enter, `n`, and EOF cancel. It runs a
temporary copy of the runtime so installed executables can be removed on Windows.
Only owned commands and MDR installation data are removed. External custom
state/log/history directories and source checkouts are retained.

## Source development and validation

Source development requires Node 24+, npm and Go capable of using the toolchain
pinned in `release-toolchain.lock.json`. Build tools are not installed globally.

```powershell
.\install.ps1 --local-only --no-global-command
npm run test:windows
npm run release:check
npm run release:bundle -- --allow-dirty
```

`--allow-dirty` produces a **non-publishable local candidate**. Production builders
must run on the matching native Windows architecture with a clean source commit.
Windows production dependencies are installed from the npm lock without install
scripts; the POSIX-only node-pty backend is not shipped in Windows packages. The
small Go host uses only Win32 bindings and does not invoke agents or model APIs.

Published assets require per-platform runtime tests, exact ZIP verification,
checksums and build provenance. Real ChatGPT/Tunnel round trips, administrator vs
standard-user environments and untested Windows versions must be reported
separately from local SDK/package checks. See [validation](VALIDATION.md).
