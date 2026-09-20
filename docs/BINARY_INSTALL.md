# Precompiled installation

**English** | [简体中文](BINARY_INSTALL.zh-CN.md)

The [v1.0.1 release](https://github.com/dolibali/mcp-dev-runtime/releases/tag/v1.0.1) contains four platform-specific runtime archives. Each includes Node.js 24.21.0, the compiled application, production native dependencies, and the runtime-only Tunnel built from the exact commit in `tunnel.lock.json`. No system Node, npm, Git, Go or compiler is needed to install or run MDR. Tools required by your own development projects remain your responsibility.

## Choose and verify the download

| Archive suffix | Target / native verification baseline |
| --- | --- |
| `darwin-arm64.tar.gz` | Apple Silicon; macOS 14 |
| `darwin-x64.tar.gz` | Intel Mac; macOS 15 |
| `linux-x64-gnu.tar.gz` | x64; Ubuntu 22.04, glibc and GCC 12 libstdc++ |
| `linux-arm64-gnu.tar.gz` | ARM64; Ubuntu 22.04, glibc and GCC 12 libstdc++ |

Other distributions/older OS releases are not asserted to be verified merely because they share an architecture. Alpine/musl and native Windows are not supported by these packages. Use `uname -s` and `uname -m` to identify the computer. Download the matching archive and `SHA256SUMS` from the same release, not GitHub's automatic source snapshot.

On macOS, from the download directory:

```bash
shasum -a 256 mcp-dev-runtime-1.0.1-darwin-arm64.tar.gz
```

On Linux:

```bash
sha256sum mcp-dev-runtime-1.0.1-linux-x64-gnu.tar.gz
```

Compare the entire hash with the matching filename in `SHA256SUMS`. Substitute your actual architecture filename. A checksum checks consistency, not publisher identity by itself. GitHub build provenance is available separately with `gh attestation verify ARCHIVE --repo dolibali/mcp-dev-runtime` for users who already have `gh`.

**This release deliberately skips publisher code signing and Apple notarization.** Upstream/ad-hoc component signatures are not a signature by this project's publisher. macOS may require explicit approval for downloaded software. Review the source/release and checksum before allowing it; the installer never disables Gatekeeper, changes system security settings, or strips quarantine attributes. The release workflow has a signing boundary reserved for a later signed release.

## Install

For Apple Silicon, for example:

```bash
tar -xzf mcp-dev-runtime-1.0.1-darwin-arm64.tar.gz
cd mcp-dev-runtime-1.0.1-darwin-arm64
./install.sh
```

Use the matching archive/directory on other platforms. `bash install.sh` also works when an extraction tool dropped the outer script's executable bit. The installer verifies the extracted file manifest, copies the package to a versioned user directory, creates missing private config files, and registers `mcp-dev-runtime` plus `mdr` when the short name is available. Existing unrelated `mdr` commands are skipped, never executed or overwritten. A conflicting canonical command is refused; see source coexistence below.

The installer does not download dependencies, compile, use sudo, edit shell profiles, start services, or copy existing credentials. If it prints a PATH instruction, add the displayed bin directory to your own shell configuration. Defaults:

```bash
export PATH="$HOME/.local/bin:$PATH"
mdr paths
mdr doctor --offline
```

Use `mcp-dev-runtime` in place of `mdr` when the short command was skipped. The installed entry uses the bundled Node privately and does not register/replace a system `node` or change the PATH inherited by development commands.

## Configuration and runtime data

`mdr paths` reports only the effective paths for the selected installation. It does not display proposed future directories.

| Data | macOS default | Linux default |
| --- | --- | --- |
| Config + `runtime.env` | `~/Library/Application Support/mcp-dev-runtime/` | `~/.config/mcp-dev-runtime/` |
| State + default history | `~/Library/Application Support/mcp-dev-runtime/runtime/` | `~/.local/state/mcp-dev-runtime/` |
| Logs | `~/Library/Logs/mcp-dev-runtime/` | `~/.local/state/mcp-dev-runtime/logs/` |
| Program versions | `~/Library/Application Support/mcp-dev-runtime/releases/` | `~/.local/share/mcp-dev-runtime/releases/` |

Linux honors absolute `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and `XDG_DATA_HOME`; relative values are ignored. `--prefix` changes only the program-version directory, not user configuration. `--bin-dir` selects a different command directory. Config files must be user-owned regular files with mode `0600`, and the config directory must be user-owned mode `0700`; symlinks and unsafe permissions are refused rather than silently repaired. Existing config content is preserved.

v1.0.1 generates one non-secret `config.json` plus adjacent private `runtime.env`. The config points `runtime.env_file` at that file automatically. Open `runtime.env` in a plain-text editor and enter your real Tunnel ID and runtime key; do not put secret values in JSON, chat or shell arguments. The already-published v1.0.0 keeps its original split configuration. Then:

```bash
mdr tunnel-setup
mdr start --bg
mdr status
mdr doctor
mdr smoke
```

The checks are local readiness/discovery, not proof of the ChatGPT round trip. A normal `status` is concise; `--verbose` gives details and `--json` preserves the machine object. `mdr config` shows effective non-secret settings and `mdr tools` shows enabled tool policy. Unified config uses `runtime.logs_dir` / `runtime.state_dir`; legacy split installations retain their old fields. There is no separate error.log.

## Upgrade, rollback and source coexistence

Review running tasks and run `mdr stop` before switching versions. Download and verify the new archive, then run its installer with the **same prefix and bin directory**. Each version gets its own directory; a `current` symlink is switched atomically after integrity/configuration checks. The installer refuses an active or unreachable selected instance, a changed existing version directory, and foreign command files. It does not delete previous versions or overwrite config. Rollback uses the previous trusted package's installer after stopping the service. Check release notes for history-format compatibility before downgrading.

An existing source-checkout command is not automatically reassigned to a binary installation. Source config, credentials and `.runtime` are never moved automatically. To coexist, run the binary installer with `--no-global-command` and use the printed absolute installed command path, or use a separate `--bin-dir`. For an explicit migration, stop the old source instance, unregister only its owned commands using its documented command-uninstall operations, then install the binary and deliberately transfer settings in your editor. Avoid two instances on the same ports or history directory.

The immutable v1.0.0 archive provides `./install.sh --unregister` for command-entry removal only. **v1.0.1 adds a complete `./uninstall.sh`.** It shows the exact owned paths first and requires an explicit `y`; it then safely stops the owned managed instance and removes owned commands, all installed versions, configuration/credentials, default state/history, logs and cache. Installation also stores a stable `uninstall.sh` in the user configuration directory, so the original downloaded archive is not required later. Foreign command files and external custom state/log/history paths without sufficient ownership proof are kept rather than recursively deleted.

Lifecycle commands are `mdr start [--background|--bg]`, `mdr stop`, `mdr restart [--background|--bg]` and `mdr status`. `up` and `down` remain aliases for existing scripts. `restart` waits for an owned instance to stop before starting the replacement; it fails closed if the selected controller is unreachable rather than signalling a PID from disk. Restarting or stopping also ends commands owned by that MCP runtime, so inspect active work first.

`mdr serve --transport http` or `mdr serve --transport stdio` remains available for local clients without Tunnel. `serve` preserves the caller's workspace; use explicit `--config` and a separate history directory when running an additional instance. Source development and npm publication are separate: the npm package remains private, and the source `./install.sh` remains a build-oriented installer.
