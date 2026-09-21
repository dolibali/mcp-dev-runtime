# Contributing

Use Node.js 24+, install with `npm ci`, and build with `npm run build`. The tools execute locally; do not add model calls, Agent delegation or a dependency on the Codex executable.

Keep the six tool contracts synchronized with observable behavior. Preserve nonzero process exit codes, output cursor semantics, error envelopes and partial patch reports. Add regression tests for new behavior and run `npm run test:all`. Use temporary files and stop only processes created by the tests. No contributor credentials are needed for automated tests.

Version changes update package.json, package-lock.json and tunnel.lock.json together. Tunnel upgrades also update the optional submodule pin and compatibility records. Native Windows development uses the isolated backend and acceptance suite described in [docs/WINDOWS.md](docs/WINDOWS.md); do not modify or skip POSIX behavior to make Windows tests pass.

The repository is licensed under Apache-2.0. By submitting a contribution, contributors license it under the repository's license. Preserve upstream attribution when adapting reference algorithms.
