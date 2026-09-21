# Validation record

## v1.2.0 native release security-descriptor correction

Native Windows release runners exposed a false post-replacement verification
failure: a DACL-only query could incidentally return owner/group fields before
replacement and omit those unrequested fields afterwards. The comparison now
explicitly requests owner, group and DACL on both sides and still requires the
complete requested descriptor to match. No permissions check is skipped and
post-commit restoration failures remain reported as partial file changes.

The local correction checkpoint passed **254 source tests** (141 unit, 41 protocol,
72 launcher), CLI verification and static release checks. All **six native Go
tests** passed three consecutive executions on the authorized Windows x64 host,
including default, inherited/protected and repeated replacement cases. Release
publication additionally requires the normal native x64/ARM64 Windows jobs and
all four existing macOS/Linux package jobs to pass for the exact release commit;
the attached release verification record is authoritative for those runs.

## Windows native adaptation — unreleased development checkpoint

The Windows work is based on v1.1.0 commit
`c54daf376fa8832eff11827e00da7e5f169a9184`. It has not been committed,
pushed or released by these checks; local candidate manifests explicitly retain
`dirty: true`. The existing live macOS MCP/Tunnel was not restarted or migrated.

Windows x64 acceptance uses an isolated source copy, synthetic HOME/workspaces
and no real Tunnel credentials. The source suite passes **35 tests**: ten shared
output/retry tests and 25 Windows-specific tests. Coverage includes PowerShell
UTF-8/explicit/native exits, real ConPTY input/output, Job-owned descendants,
timeouts, history/Skills, PNG/JPEG/WebP, case aliases, CRLF and DACL-preserving
patches, named-pipe lifecycle, command-argument forwarding, source command
registration/removal and staged complete uninstall. It does not claim that the
entire POSIX-specific test suite runs unchanged on Windows.

An additional blocked-input regression was reproduced before fixing the native
adapter: a child that never read stdin could prevent its owner from processing
EOF or termination controls. Input writes now use a bounded independent queue;
both EOF and forced-termination cases pass and confirm owned process exit.

macOS ARM64 and Linux x64 (Ubuntu 24.04 under an existing WSL2 installation)
pass **253 tests each** (140 unit, 41 protocol, 72 launcher), plus production CLI
startup/shutdown, static release checks and output benchmarks. Linux additionally
passes ten rounds of the two concurrent-start/credential-file regressions. WSL
is used only as a Linux test host; the Windows runtime does not depend on WSL.
Tests explicitly verify that ordinary POSIX execution does not load the Windows
host, and existing tool contract files are compared against the baseline.

Repeated Linux startup exposed a real wall-clock sensitivity: wall time advanced
by about 5.3 seconds while monotonic elapsed time was only 152 milliseconds.
Lifecycle duration budgets now use monotonic time, retaining wall-clock dates
for stored timestamps. Isolated child-process tests simulate both forward and
backward 60-second wall-clock corrections without changing the host clock.
The forward case fails on the old implementation and both cases pass after the
fix; existing POSIX forced-cleanup grace remains unchanged.

Package validation is separate from source tests. The Windows verifier checks
15 groups covering exact ZIP contents, offline self-contained installation,
configuration preservation, actual bundled Tunnel identity, local lifecycle,
HTTP/stdio and the six tools, opt-in Skills, rollback, conflicts and uninstall.
Release candidates must be rebuilt and this verifier rerun after native changes;
an old successful archive is not evidence for newly changed code.

Windows ARM64 helper, native test binary and pinned Tunnel cross-compilation
have passed. **Native Windows ARM64 execution and its ZIP acceptance have not
been performed locally.** CI and release workflows include separate x64/ARM64
jobs, explicitly select the Node/Go architecture, assert native runner and Node
identity, and require both native package jobs before assembling a release.
Those hosted jobs have been configured and checked, not executed in this local
development operation. ARM64 compile-only results are not publication approval.

Private evidence includes source manifests, Windows native/package logs, macOS
and Linux logs, exact archive manifests and three interleaved POSIX baseline/
candidate benchmark runs. Output benchmarks preserved all 200,000 bytes without
duplication or loss. They measure local execution, not hosted inference or WAN
latency, and do not prove zero overhead on every machine. Windows standard-user
versus elevated-user coverage, other Windows versions, sleep/wake, multi-day
soak, and real ChatGPT/Tunnel round trips remain separate acceptance items.

## Experimental local Skills — unreleased implementation checkpoint

The implementation was developed against baseline `2872675e020217e5a3c900b03313dbae2f4e8629`
without restarting the maintainer's active MCP/Tunnel, changing its configuration,
enabling experimental tools, committing, pushing or publishing. All Skill fixtures
use temporary homes and workspaces; no private user Skill scripts were executed.

The baseline passed **207 tests** (106 unit, 33 protocol, 68 launcher). The final
source regression passed **249 tests** (140 unit, 41 protocol, 68 launcher), with
zero failures/skips. The **42 new Skill-specific tests** cover global/project/worktree
roots, canonical aliases, duplicate names, disabled paths, malformed YAML and
sidecars, explicit-only invocation, dependencies as data, safe resource paths,
binary/oversized/FIFO rejection, BOM/CRLF/UTF-8 preservation, changed/deleted files,
signed scope-bound pagination, expiry/eviction, cache sharing, query matching,
concurrency limits, legacy/unified config, actual HTTP/stdio and reconnection.

The six original tool contract objects were deep-compared against the saved
baseline and remained identical. A real legacy MCP initialize response with Skills
disabled was byte-compared to the previous generated server instructions and was
identical. Module-resolution hooks verified that both disabled and enabled-but-unused
servers execute ordinary commands without loading the Skill service or YAML parser.
`verify:cli`, `release:check` and `git diff --check` passed.

The Apple Silicon precompiled candidate was built from the working tree with
`dirty: true` explicitly recorded in its manifest. It passed **18 package acceptance
groups** and the existing **20 real-tool checks**. The new isolated stdio group
uses the bundled Node/YAML, discovers and reads a synthetic Skill, follows all
UTF-8 reference pages and then executes an ordinary command. Default-only six-tool
tests, install/reinstall, lifecycle (mock Tunnel), upgrade/rollback, command conflict,
complete uninstall and preservation of a synthetic shared user Skill also passed.
This is a local test candidate, not a replacement for published v1.0.1 assets.

### Performance observations (macOS ARM64, Node 24.15.0)

The existing benchmark preserved all 200,000 output bytes with zero duplicate or
missing consumed bytes. Its loopback MCP P50/P95 was **13.43/15.84 ms** before
and **10.97/16.35 ms** after this change. These are separate runs, not a causal
speedup claim or proof of zero regression.

The dedicated benchmark uses 100 synthetic Skills and interleaves ordinary command
calls with Skills disabled versus enabled-but-unused. Three runs recorded:

| Measurement | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- |
| Cold discovery, including HTTP and lazy initialization | 116.68 ms | 64.43 ms | 59.19 ms |
| Hot discovery P95 | 1.77 ms | 0.95 ms | 0.89 ms |
| Warm main-instruction read P95 | 2.13 ms | 1.23 ms | 1.39 ms |
| Ordinary command P95, Skills disabled | 5.19 ms | 3.12 ms | 2.97 ms |
| Ordinary command P95, enabled but unused | 7.91 ms | 3.11 ms | 3.08 ms |
| Ordinary command P95 during forced refresh | 8.56 ms | 5.89 ms | 5.87 ms |

The higher first-run tail and concurrent refresh cost are retained here rather
than hidden. Medians are comparable and later runs were closer, but finite local
measurements do not establish zero overhead. Read pagination reproduced all
**124,000 UTF-8 bytes**, with zero missing/duplicate bytes across six resource
calls. The measured result wire totals include the intentional compatibility mirror:
4,768 bytes for five short candidates, 1,188 bytes for the sample main instruction,
and 269,340 bytes across the long reference read. Byte budgets are not exact model
tokens, and cache accounting is not total process RSS.

Detailed raw reports remain in ignored `reports/` and `.runtime/skills-dev/`.
No hosted ChatGPT trigger-rate, semantic Skill-selection accuracy, model token
billing or Tunnel-WAN latency was measured. Those require explicit enablement,
client metadata refresh and new-conversation acceptance. This checkpoint did not
run native Linux or Intel Mac CI; the shared package verification is ready for
those runners when a future release is authorized.

## Complete uninstall — development after v1.0.0

The source checkout now has a complete interactive `uninstall.sh`. Isolated tests confirm that only explicit `y` / `Y` proceeds, while `n`, empty input and EOF cancel without deletion. Confirmed source removal deletes generated runtime/config/build data and owned command wrappers while retaining the Git checkout, including the pathological case where configured state/log/history paths resolve to the checkout root.

At the uninstall-only checkpoint, the local source regression passed **199 tests** (**104 unit, 32 protocol, 63 launcher**), with no failures or skips, plus `verify:cli` and `release:check`. A rebuilt Apple Silicon precompiled candidate then passed **15 package-verification groups** and the existing **20 real-tool checks**. That package verification covers the stable installed uninstaller, cancellation, complete owned program/default-user-data removal, preservation of an unrelated `mdr` executable, preservation of explicitly external custom history, and retention of the downloaded bundle itself. The published v1.0.0 assets are immutable and do not retroactively gain this script.

## Unified configuration and tool policy — development after v1.0.0

New installations now create one non-secret `config.json` plus private `runtime.env`. Existing `launcher.config.json + config.json` installations remain in `legacy-split` mode and are not rewritten automatically. Regression coverage verifies unified relative-path semantics, preservation of existing legacy launcher files, `--config` across lifecycle/doctor/smoke/paths, and read-only `config` / `tools` inspection without credential contents.

`tools.allow` is fail-closed at both MCP registration and Runtime invocation. The established six tools remain enabled by default; unknown names, duplicates and wildcard entries are rejected. A disabled tool is absent from MCP discovery and a direct Runtime bypass returns `TOOL_DISABLED` before side effects. `tunnel.enabled=false` was also exercised through the managed launcher: MCP reaches ready without Tunnel credentials, Tunnel binary resolution or a Tunnel health listener, and status explicitly reports Tunnel disabled.

The current full source regression passed **206 tests** (**106 unit, 33 protocol, 67 launcher**), with no failures or skips, plus `verify:cli` and `release:check`. The local benchmark completed with runtime **p50 7.26 ms / p95 9.99 ms** and MCP HTTP **p50 10.89 ms / p95 16.00 ms**; the 200,000-byte output check reported **0 duplicate and 0 missing bytes**. These are local measurements, not throughput guarantees.

After the unified-config changes, a fresh Apple Silicon precompiled candidate was rebuilt and passed **17 package-verification groups** plus the same **20 real-tool checks**. The package verifier confirms unified config mode, one effective non-secret config, exactly six default-enabled stable tools, ordinary Tunnel-managed lifecycle, upgrade/rollback, complete uninstall, stdio and all six MCP tools. No published v1.0.0 asset was changed.

## v1.0.0 precompiled distribution

The release workflow is the source of truth for the final per-platform result. Every published archive must pass `scripts/release/verify.mjs` on its native runner and match the same clean source commit. The release-level `VERIFICATION.json` and per-archive `BUILD-MANIFEST.json` record results, versions, platform and skipped publisher signing. Local macOS ARM64 candidates passed the package acceptance checks, including the 20 real-tool checks, under an isolated HOME and guarded PATH without system build tools. The final package gate also checks the documentation links and anchors after packaging, rather than assuming source-README anchors exist in the binary landing page.

Release-preparation regressions covered binary/source layout separation, XDG path validation, private initialization, caller-relative state/log overrides, bundle integrity and explicit signing-skip behavior. The release-hardening pass also verifies that the first observable ready supervisor includes a complete health snapshot, and that response-loss recovery follows explicit output cursors until the original process actually exits. Final counts and platform results belong to the workflow for the release commit. Historical checkpoints below refer to earlier development versions, not newly repeated performance or cloud tests.

## Resolved path reporting — 2026-09-20

The local checkout now exposes `mdr paths` / `mdr paths --json` without changing the active service or moving existing files. It reports only paths actually resolved by the selected installation/configuration: package root, launcher config, runtime config, state directory and log directory. Regression coverage verifies those values through the registered short command and confirms that no hypothetical future-path object is emitted.

## Status output modes — 2026-09-20

The launcher CLI now defaults to a concise human-readable `status` view, with `--verbose` for operational detail and `--json` preserving the previous complete supervisor object. The registered `mdr` entry was exercised against the existing managed macOS instance from outside the repository: concise output reported ready MCP/Tunnel state, session/history counts, uptime and the resolved log directory; verbose output added process IDs, instance IDs, latencies, memory, retained output, history size and Tunnel version; JSON retained `run_id`, component PIDs and log objects. No service restart was required because the wrapper resolves the rebuilt CLI entrypoint.

## Automatic mdr registration and log documentation — 2026-09-20

This update passed **188 tests** (104 unit, 32 protocol, 52 launcher), with no failures or skips, plus the isolated production-CLI verification. Normal setup now registers `mcp-dev-runtime` first and automatically registers `mdr` only when the short name is conflict-free. A short-name conflict skips only `mdr`; setup still completes successfully with the canonical command. Explicit `command:install -- --name mdr` remains strict. Regressions cover coexistence, independent removal, literal arguments, same-name executable conflicts before and after the destination on PATH, foreign destination files/symlinks, supported-name validation, canonicalized PATH entries, CLI registration and setup-level conflict skipping. Test fixtures use private temporary directories and do not invoke foreign commands to identify them.

The short and long commands addressed the same isolated managed instance, and the documented absolute log paths matched `status.logs[].file`. A real disposable-HOME `./install.sh --local-only` run created both user commands when `mdr` was free; after removing only the short wrapper and introducing a foreign `mdr` executable on PATH, setup completed successfully, preserved the foreign file byte-for-byte, did not execute it, and left only `mcp-dev-runtime` registered. Separately, on the maintainer's existing macOS deployment, command-only registration followed by cross-directory `mdr status`, `mdr doctor --json` and `mdr smoke` succeeded without restarting the service or modifying the long-command wrapper. No claim is made that current PATH inspection can see parent-shell aliases/functions, or prevent conflicts introduced by future installations.

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
