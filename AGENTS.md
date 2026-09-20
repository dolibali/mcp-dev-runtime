# Development conventions

This repository implements direct local MCP tools. Do not invoke Codex, any other agent, or model APIs to implement or execute tools. No model calls belong in the server.

Keep the six tool names and schemas in contracts/tools.json aligned with actual behavior. Shared process lifetime must outlive individual HTTP requests. Permission approval, sandbox and command-whitelist systems are outside scope.

Run npm run test:all after changes, and npm run benchmark for runtime/output changes. Tests must create their own temporary directories and stop only processes they own. Do not access user credentials, modify existing Tunnel deployments, or automatically switch the user's ChatGPT application.

Preserve actual nonzero exit codes and partial file-change reports. Never claim cross-file transactions, persistent exactly-once retries, or an identical model success rate to Codex. Record unverified hosted-client behavior separately from local SDK tests.
