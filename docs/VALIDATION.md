# 0.3.0 local validation record

## Global-command update — 2026-09-20

The global-command update passed **179 tests** (104 unit, 32 protocol, 43 launcher), with no failures or skips, plus the isolated production-CLI check. A clean source copy in a disposable HOME passed real `npm run setup -- --local-only`, command registration, cross-directory offline doctor, idempotent reinstallation and command-only removal. These checks used no real Tunnel credentials. Full managed up/status/doctor/smoke/down and stdio were exercised through the registered command in isolated installations; their Tunnel endpoint was an explicitly mocked local process.

Regression cases cover spaces, quotes and Unicode paths, literal argument forwarding, missing or shadowed PATH entries, existing-command protection, symlink refusal, concurrent registration, command-only removal, a moved/missing build, caller-relative path flags, installation-relative managed configuration and preservation of caller cwd for stdio. The earlier full Tunnel build and deployed workload measurements below remain separate historical checkpoints, not newly rerun benchmarks for this command-registration change.

## Earlier one-click installation checkpoint

2026-09-20, macOS ARM64. `npm run test:all`: **168 passed** (104 unit, 32 protocol, 32 launcher), no failures or skips. CLI startup/cleanup, release checks and 20 deployed checks passed. A 45-second isolated four-worker workload completed 2003 commands and 179 health checks without unexpected failures, while exercising bounded history rotation.

The one-click setup path was also exercised from a disposable source copy with no `node_modules`, no `.runtime` cache and no initialized Tunnel submodule. `./install.sh` installed the locked npm dependencies, built the runtime, created only missing local configuration, fetched OpenAI `tunnel-client` at the exact commit in `tunnel.lock.json`, built `tunnel-client-runtime`, verified the expected version/commit and SHA-256, then passed offline doctor. A second run preserved the existing configuration, skipped `npm ci`, and reused the verified Tunnel binary. Dedicated setup regressions additionally cover local-only mode, missing build prerequisites, active-runtime protection and `runtime.env` symlink refusal.

The six original tool methods were also exercised through the ChatGPT connection after deployment. At the initial deployment checkpoint, new optional arguments had passed deployed SDK tests but the hosted schema still required refresh. After that refresh on 2026-09-20, actual hosted calls verified `label`, `capture_output`, `scope=history`, `archive_id`, `tail_lines`, `search` and `max_matches`. The same capture → history lookup → archived tail/search flow was exercised again while checking the bilingual README examples.

Real process-restart history recovery is tested; physical sleep/wake, WAN interruption, multi-day soak and power-loss durability are not claimed by this local validation. Private historical reports and lock-file validation notes describe their own checkpoints, not an automatically refreshed live status.

Detailed usage and limits: [HISTORY_AND_RECOVERY.md](HISTORY_AND_RECOVERY.md). Private machine-specific logs are stored under ignored `reports/three-batches-20260920/`.

## Earlier release record (historical)

# 0.2.0 validation record

Recorded 2026-09-20. Environment: macOS 26.5.2, Apple Silicon arm64, Node.js v24.15.0. The record distinguishes local execution from hosted-product acceptance.

| Check | Observed result |
| --- | --- |
| Core tests | 79 passed, 0 failed |
| HTTP/stdio protocol tests | 22 passed, 0 failed |
| Launcher lifecycle tests | 19 passed, 0 failed |
| Total automated tests | 120 passed, 0 failed |
| Independent production CLI startup and stop | passed |
| Deployed endpoint checks, including all six tools | 14 passed |
| Full and run-only Tunnel version recognition | passed for locked source |
| Actual narrow Tunnel build and control-plane readiness | passed on macOS arm64 |
| Repeated actual background up | same managed instance, not a duplicate |
| Ubuntu/macOS GitHub Actions | workflow files created; not run on GitHub in this operation |
| Linux hardware/container execution | not performed; no running Linux container engine available |
| Native Windows | not supported |
| Hosted ChatGPT calls after this update | not performed in this operation |

Launcher tests use an explicit test-only Tunnel and isolated launcher configuration; they do not load user credentials. The real integration check separately uses an authorized private Tunnel. Source/private environment credentials are not included in this report. A live/ready Tunnel and direct SDK calls do not establish final hosted ChatGPT acceptance.

The runtime passed actual code read/patch/test/diff, TypeScript-error repair, interactive PTY, image-return, output continuation and error-path checks. Full command/test logs and machine-specific state remain outside the public source set. CI configuration is not reported as an executed platform test.

## Compatibility pair

Project 0.2.0; tool contract 3.0; upstream source version 0.0.14; exact commit 70bb5a7e1305596f0216d7b18d0b7765d58576d5; preferred variant tunnel-client-runtime. A local build is not an official upstream signed release artifact.
