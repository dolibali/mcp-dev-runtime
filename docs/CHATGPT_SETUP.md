# Connect ChatGPT on the web: an illustrated beginner tutorial

**English** | [简体中文](CHATGPT_SETUP.zh-CN.md) · [Back to README](../README.md)

**Goal:** select `mcp-dev-runtime` in a ChatGPT conversation and use the local service for development operations you authorize. This creates your own developer-mode app, not an Action under “Explore GPTs → Create a GPT,” and not a public plugin-store submission.

Web entry points and official references reviewed: **2026-09-20**. Accounts may show Plugins, Apps, or Connectors. The guide provides a main route and an alternative; unavailable permissions require an administrator or official support, not a workaround that bypasses access controls.

This walkthrough targets **project 0.3.0 / tool contract 3.1**. The signed-in account pages must be opened in your own browser; reviewing public documentation is not a claim of having inspected your account's current UI. Complete each checkpoint before moving on. In particular, do not scan tools before both local services are online.

> **Key safety:** never put a real API key in chat, screenshots, a README, or GitHub. Complete configuration in your own browser and terminal. The runtime executes with the service user's OS permissions and has no additional sandbox; read [security guidance](../SECURITY.md) first.

## The whole process

[Check accounts](#step-0) → [Enable developer mode](#step-1) → [Install locally](#step-2) → [Create a Tunnel and copy its ID](#step-3) → [Create an API key](#step-4) → [Fill in local configuration](#step-5) → [Start services](#step-6) → [Create the ChatGPT app and choose Tunnel](#step-7) → [Make the first call](#step-8).

| Purpose | Official page |
| --- | --- |
| ChatGPT on the web | [chatgpt.com](https://chatgpt.com/) |
| Create a developer-mode app | [ChatGPT Plugins](https://chatgpt.com/plugins) |
| Earlier Apps / Connectors settings | [ChatGPT Connectors](https://chatgpt.com/#settings/Connectors) |
| Create a runtime API key | [Platform → Organization → API keys](https://platform.openai.com/settings/organization/api-keys?utm_source=chatgpt.com) |
| Create a tunnel or find its ID | [Platform → Organization → Tunnels](https://platform.openai.com/settings/organization/tunnels) |
| Find an Organization ID | [Platform → Organization → General](https://platform.openai.com/settings/organization/general) |
| Manage tunnel permissions | [Platform → Organization roles](https://platform.openai.com/settings/organization/people/roles) |

The `utm_source=chatgpt.com` part of the API keys link is a referral parameter. [Without it](https://platform.openai.com/settings/organization/api-keys), the link still uses the same settings path; it is not part of a key.

### Four values that are easy to confuse

| Name | Example or format | Where it belongs |
| --- | --- | --- |
| App name | `mcp-dev-runtime` | Name in ChatGPT's app-creation form |
| Tunnel ID | `tunnel_` followed by 32 lowercase hexadecimal characters | Local `CONTROL_PLANE_TUNNEL_ID`; ChatGPT's tunnel selection or ID field |
| Runtime API key | The complete secret shown when the key is created | **Only in local configuration** as `CONTROL_PLANE_API_KEY`; the Tunnel client uses it to authenticate to OpenAI at runtime |
| Local MCP address | `http://127.0.0.1:3001/mcp` | The service that the local Tunnel client forwards to; not a Tunnel ID |

The API keys page does not generate Tunnel IDs. An organization ID, workspace ID, tunnel display name, or tool execution `session_id` cannot replace a Tunnel ID either.

<a id="step-0"></a>
## Step 0 — Confirm the accounts and target workspace

Sign in to ChatGPT in your browser and identify whether you will use a personal, company, or school workspace. In another tab, sign in to OpenAI Platform and select the organization you are authorized to use. For first-time setup, using the same account with access to both resources reduces accidental account mismatches.

**ChatGPT developer-mode access, Platform organization permissions, and key permissions are separate.** A subscription, source checkout, or ordinary API key does not automatically grant all three.

The current [developer guide](https://developers.openai.com/api/docs/guides/developer-mode) and [Help Center article](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt) do not describe identical interfaces or account availability. This guide starts with the developer-guide route and provides the Help Center alternative. Your account's actual availability and workspace policy take precedence; a plan name alone is not a guarantee of every permission.

**Checkpoint:** you know which ChatGPT workspace and Platform organization you intend to connect, rather than unknowingly using different accounts across tabs.

<a id="step-1"></a>
## Step 1 — Enable developer mode in ChatGPT on the web

Follow the current [official developer guide](https://developers.openai.com/api/docs/guides/developer-mode):

1. Open [ChatGPT](https://chatgpt.com/), open your profile/account menu, and choose **Settings**.
2. Open **Security and login**.
3. Find **Developer mode**, review the warning, and enable it.
4. Open [Plugins](https://chatgpt.com/plugins) and confirm that the page's **plus button** can create a developer-mode app. Locate the entry point for now; you do not need to submit the form yet.

**If that toggle is missing:** look under **Settings → Apps → Advanced Settings → Developer mode**. Earlier interfaces may call Apps “Connectors.” The Help Center also documents an administrator route through **Workspace settings → Apps → Create**. Managed workspaces may first require an administrator to grant access under **Permissions & Roles → Connected Data**. A permission problem is not a local installation failure. See the [official help](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).

This is not the browser's F12 developer-tools panel, and it does not require experimental browser settings.

**Checkpoint:** developer mode is enabled for your account, and you can find the custom-app creation entry point.

<a id="step-2"></a>
## Step 2 — Install the project on your computer

On macOS, use Spotlight to open **Terminal**. On Linux, open your terminal application. Run the following commands in **that local terminal**, not in the ChatGPT message box. Code blocks do not include a shell prompt; execute one line at a time.

Check the installed tools first. Node.js must be **24 or newer**:

```bash
node --version
npm --version
git --version
```

If Node.js is missing, follow the [official Node.js installation instructions](https://nodejs.org/en/download), reopen the terminal, and check again. On macOS, follow the system's Command Line Tools installation prompt if Git or native build tools are missing. Other prerequisites are in [README requirements](../README.md#requirements). Do not run this project with `sudo`.

Choose a directory in which to keep the source, then run:

```bash
git clone https://github.com/dolibali/mcp-dev-runtime.git
cd mcp-dev-runtime
./install.sh
```

A private repository requires GitHub access. For `Repository not found`, check repository access and Git authentication before troubleshooting Tunnel. With an already-downloaded source archive, skip `git clone` and enter the extracted project directory.

The setup installs the exact npm dependency lock, builds MCP Dev Runtime, creates the three local configuration files only when missing, and verifies or builds the exact Tunnel source pinned by `tunnel.lock.json`. It does **not** require your Tunnel ID or API key yet and never installs system packages with sudo, Homebrew or apt. If a Tunnel build is needed but Git, Go or `make` is missing, install the named prerequisite using its official/system instructions and rerun `./install.sh`.

For the first connection, you can keep `cwd: "."` in `config.json` and launch from the repository root. To change the default workspace, use an existing absolute directory. `cwd` is not a filesystem allowlist. Run subsequent terminal commands from this repository too. Re-running setup is safe for the local config files: existing `config.json`, `launcher.config.json` and `runtime.env` are preserved.

Keep the default listener on `127.0.0.1`; do not expose this unrestricted runtime publicly. Edit configuration as plain-text JSON with double quotes, no comments and no trailing comma. Already have this checkout? Enter its directory instead of cloning over it, and do not reinstall dependencies underneath active tasks. Native Windows is unsupported; see the requirements before starting on another platform.

**Checkpoint:** the script ends with `MCP Dev Runtime setup complete` and the offline diagnostic passes. This confirms local installation, not a live ChatGPT connection.

Setup also registers `~/.local/bin/mcp-dev-runtime`. If it prints a PATH instruction, apply that instruction before using the global command; otherwise the existing `npm run ...` commands below remain usable from this repository. Registration never changes your shell profiles or starts a service. See [global command usage](../README.md#global-command).

<a id="step-3"></a>
## Step 3 — Create a Tunnel and find its real ID

### 3.1 Open the correct page

Go to [Platform → Organization → Tunnels](https://platform.openai.com/settings/organization/tunnels) and check the selected organization. If you already have a tunnel you are authorized to use, open that record instead of creating a duplicate.

Otherwise, select **Create tunnel**. The fields in the reference illustration mean:

| Field | What to enter |
| --- | --- |
| Name | A recognizable computer label such as `my-mac-dev`; not the Tunnel ID |
| Description | A brief purpose description, as requested by the form |
| Organization IDs | Select or enter the actual Platform organization ID; do not copy the illustration's placeholders |
| Workspace IDs | Associate the ChatGPT workspace you intend to use, particularly for discovery in that workspace's tunnel picker |

![Official reference: creating a tunnel with separate organization and workspace associations](images/openai/tunnel-create-modal.png)

*Source: the OpenAI tunnel-client repository's [Create tunnel reference image](https://github.com/openai/tunnel-client/blob/70bb5a7e1305596f0216d7b18d0b7765d58576d5/docs/images/tunnel-create-modal.png). This is an illustration with placeholder data, not a screenshot of your account.*

### 3.2 Where do organization and workspace IDs come from?

Look for the Organization ID in [Platform organization General](https://platform.openai.com/settings/organization/general). For ChatGPT workspaces with administrative settings, open the profile menu, then **Workspace settings → General**, and find the workspace identifier. The official [workspace settings article](https://help.openai.com/en/articles/8411955-managing-workspace-settings-in-chatgpt-enterprise) lists workspace and organization identifiers under General.

If associations are already filled in or offered through a picker, confirm and select them. If you cannot find the workspace ID, your personal account lacks that administration view, or a required field offers no valid option, ask the administrator or OpenAI support to confirm the association. Do not substitute an email, chat URL, or Platform project ID. An association with a Platform organization alone does not guarantee visibility in the target ChatGPT workspace.

### 3.3 Copy the ID after creation

After choosing **Create**, return to the Tunnels list and copy the **complete ID** from the new record's **ID** column or detail view. If the list abbreviates it, use its copy control or open the detail page rather than copying an ellipsis.

The real format is `tunnel_` followed by 32 lowercase hexadecimal characters. Keep this ID: local configuration and ChatGPT's connection must refer to the **same tunnel**. The ID is not a password, but actual deployment identifiers should not be published casually.

Creating/managing tunnels requires **Read + Manage**; running/selecting one requires **Read + Use**. A newly created record may take about 25–30 seconds to become available. Role propagation can take longer; current official troubleshooting allows up to approximately 30 minutes. Do not repeatedly create identically named tunnels to work around permissions. [Permission guide](https://github.com/openai/tunnel-client/blob/master/docs/permissions.md) · [Official troubleshooting](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#troubleshooting)

**Checkpoint:** you have copied a real Tunnel ID and confirmed its target workspace association and use permissions.

<a id="step-4"></a>
## Step 4 — Create the runtime key on the API keys page

Open **[Platform → Organization → API keys](https://platform.openai.com/settings/organization/api-keys?utm_source=chatgpt.com)**. Use the organization and identity authorized for the target tunnel. Do not switch to the adjacent **Admin keys** page.

1. Select **Create new secret key**, or the equivalent create-key action if the label differs.
2. If a Name field appears, use a recognizable label such as `mcp-dev-runtime-local`. If identity or project selection is required, use the context in that organization already authorized for the target tunnel.
3. Set Permissions to **Restricted**. Following the [official tunnel permission guide](https://github.com/openai/tunnel-client/blob/master/docs/permissions.md#creating-keys), grant the required **Tunnels → Read + Use**. Do not choose All or an admin key merely to avoid configuring permissions.
4. Create the key and copy the **complete secret** to a secure local location for `runtime.env` in the next step. A masked list entry is not the full secret. If the full value is no longer retrievable, create a replacement and revoke the obsolete key.

The key's principal must independently have Read + Use on that tunnel; selecting key permissions cannot exceed organization authorization. If Tunnels permissions are missing, confirm the organization-level page and permissions with an administrator. Generic Read Only is not a replacement for Use.

![Official reference: organization-role Tunnels Read, Manage and Use permissions](images/openai/tunnel-permissions-role.png)

*This is the **organization-role permission screen, not the API-key creation dialog**. It identifies permission names; a runtime normally needs Read + Use, not every option in the illustration. Image source: [official permissions documentation](https://github.com/openai/tunnel-client/blob/master/docs/permissions.md). The general create-key button is documented in [API key management help](https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform); follow the tunnel-specific guide for tunnel scopes.*

**Checkpoint:** you have a runtime API key, not an admin key, ChatGPT password, key name, or abbreviated preview.

<a id="step-5"></a>
## Step 5 — Put both values in local configuration

Return to the terminal in the project directory. Create files without overwriting existing configuration:

```bash
umask 077
test -f launcher.config.json || cp launcher.config.example.json launcher.config.json
test -f runtime.env || cp .env.example runtime.env
chmod 600 runtime.env
nano runtime.env
```

Replace the placeholder to the right of each equals sign with your own value, one setting per line:

```dotenv
CONTROL_PLANE_TUNNEL_ID=tunnel_00000000000000000000000000000000
CONTROL_PLANE_API_KEY=replace-with-your-own-runtime-key
```

The zero-filled ID and `replace-with-your-own-runtime-key` are **not usable credentials**. Paste the actual values without smart quotes, embedded newlines, or Markdown backticks. `runtime.env` must be a plain-text file, not `runtime.env.txt`.

In nano, use **Control+O → Enter** to save, then **Control+X** to exit. On macOS this is Control, not Command. Do not screenshot the file. It is excluded by `.gitignore`; never force it into a commit with `git add -f`.

A plain-text editor is an alternative when nano is unavailable. Do not diagnose the key by running `cat runtime.env`, dumping environment variables, or printing its value. A secret copied into chat or Git should be revoked/replaced, not merely hidden from the latest version. See [OpenAI's API key safety guidance](https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety).

This guide loads the file explicitly with `--env-file runtime.env`; the launcher does not unconditionally load a file of that name. Nonempty exported environment variables take precedence. If editing the file still uses an old account, inspect how the terminal environment is configured without printing the secret values.

**Checkpoint:** both real values are in a local file, not in chat or the repository.

<a id="step-6"></a>
## Step 6 — Verify the Tunnel client and start both local services

### 6.1 Verify what the one-click setup installed

The default `./install.sh` from step 2 has already prepared the Tunnel client. Confirm the verified binary can be resolved:

```bash
npm run tunnel:setup
```

If you intentionally ran `./install.sh --local-only`, or setup previously stopped because a build prerequisite was missing, rerun the normal setup after installing the prerequisite:

```bash
./install.sh
```

The installer first tries to reuse an already-compatible binary. If none exists, it fetches the exact upstream commit from [tunnel.lock.json](../tunnel.lock.json), builds the narrow `tunnel-client-runtime`, verifies its reported source version and commit, and stores the binary plus a SHA-256 build receipt under ignored `.runtime/bin/<commit>/`. Use `./install.sh --force-tunnel-build` only when you deliberately want to repeat that exact build. `tunnel:setup` and the installer manage only the local executable; **they do not create Platform tunnels or API keys**.

### 6.2 Start and check

**Do not also run standalone `npm start`.** In this guide, `up` already starts MCP and Tunnel. If your own manually started instance occupies the same ports, stop it in its terminal first; do not kill an unknown process.

```bash
npm run up -- --env-file runtime.env --background
npm run doctor
npm run smoke
```

Check that `doctor` reports `PASS`, `runtime.ok` and `protocol.ok` are true, and the managed supervisor's `health.availability` is `ready`. Inspect toolchain results and history warnings too. `smoke` should report `LOCAL MCP SMOKE PASSED`. With the standard configuration files created above, `doctor` reads the selected configuration, so you do not need to type port numbers for routine diagnostics. `npm run status` remains available for lifecycle details.

**Default ports:** local MCP uses `127.0.0.1:3001`; Tunnel's separate health listener uses `127.0.0.1:9098`. Keep them unless they conflict with an existing service. On a conflict, change the affected `port` in `config.json` or `tunnel_health_port` in `launcher.config.json`, preserve loopback binding, and restart only after checking active work. Use distinct, unused ports and pass a changed MCP URL to `smoke`. The Tunnel ID does not change. [Port-change procedure](DEPLOYMENT.md#ports).

You do not have to run two more `curl` commands after a successful `doctor` check. Raw `/healthz` and `/readyz` requests are kept as **optional troubleshooting** in [direct component probes](DEPLOYMENT.md#direct-probes); they help isolate a failure when combined diagnostics are not working.

Keep the computer awake, online, and running the services while proceeding. Background startup is not boot-service installation and does not keep a sleeping computer online. These are local checks; the complete ChatGPT-to-computer round trip is still untested.

**Checkpoint:** both MCP and Tunnel are ready, with successful diagnostics.

For daily checks from **any terminal directory**, use `mcp-dev-runtime status`, `mcp-dev-runtime doctor` and `mcp-dev-runtime smoke`. To start with just `mcp-dev-runtime up --background`, first merge `"env_file": "runtime.env"` into the existing launcher configuration; do not overwrite the file. `mcp-dev-runtime down` stops the selected managed instance and its owned tasks, so it is not a read-only check.

<a id="step-7"></a>
## Step 7 — Create the ChatGPT app and choose Connection: Tunnel

In the same target workspace, open [ChatGPT Plugins](https://chatgpt.com/plugins) and select the **page's plus button** to create a developer-mode app. Earlier interfaces provide Settings → Apps → Create, or an administrator's Workspace settings → Apps → Create. This is not the plus button beside the chat composer.

Fill in the form as follows:

| Field / action | Choice for this project's default deployment |
| --- | --- |
| Name | `mcp-dev-runtime`, so it is easy to select in chat |
| Description | For example, “Run development commands, edit files, and read logs on my own computer” |
| Icon | Optional; leave blank for the first connection |
| **Connection** | **Tunnel**, not Server URL |
| Available tunnels / Tunnel ID | Select the tunnel from step 3; where an input is offered, paste its complete ID. It must match `runtime.env`. |
| **Authentication** | **No Authentication** for this project's default MCP-server authentication layer |
| Advanced OAuth settings / additional headers | Not needed for the default deployment |
| Scan Tools | Wait for discovery and check the six tools below |
| Create | Review the warning and settings, then create the app |

**Why No Authentication here?** The project's default MCP server listens on loopback and does not implement OAuth. Tunnel still authenticates to OpenAI using the separate runtime API key. These are different authentication layers. Do not put the runtime API key into OAuth Client Secret or disable an existing enterprise authentication gateway to copy this setup. If you have added such a gateway, use its actual authentication requirements instead.

**Do not enter `http://127.0.0.1:3001/mcp` under a public Server URL connection.** In this route, Tunnel forwards to that URL locally. No Authentication refers only to the default MCP layer; it does not disable OpenAI's Tunnel authorization or make the local service safe to expose on the internet. Supported MCP authentication choices are listed in the [official developer guide](https://developers.openai.com/api/docs/guides/developer-mode).

**The official example below shows OAuth solely as part of its sample form. For this default setup, choose No Authentication as described above, not the image's OAuth selection.**

![Official reference: Connection Tunnel and the available-tunnels picker in the ChatGPT app form](images/openai/chatgpt-connector-tunnel-select.png)

*Source: [OpenAI's connector reference image](https://github.com/openai/tunnel-client/blob/70bb5a7e1305596f0216d7b18d0b7765d58576d5/docs/images/chatgpt-connector-tunnel-select.png). Its earlier menu labels, placeholder IDs, and OAuth option are not your account's current settings.*

Discovery should list `exec_command`, `write_stdin`, `apply_patch`, `view_image`, `list_exec_sessions`, and `terminate_exec_session`. Keep both local services running during discovery. If the form discovers tools automatically rather than offering a separate scan button, inspect those results before saving.

The new app may appear under Drafts or Enabled Apps with a Dev label. Sharing it within an organization can require administrator approval. This tutorial connects your own developer app: it does not require public-store publication, a repository ZIP upload, an OpenAPI file, or an uploaded local configuration. [Official connection steps](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#connect-from-chatgpt) · [Official app configuration help](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)

**Checkpoint:** the app exists and tools were discovered, not merely a completed Name field.

<a id="step-8"></a>
## Step 8 — Make the first real call in a new conversation

Start an ordinary new ChatGPT conversation. Use the **plus button beside the composer**, then Developer mode / the app picker, to select `mcp-dev-runtime`. Where supported, type `@` and choose the actual app from the list; simply typing its name does not prove it is enabled.

Send the following and review the command when an authorization prompt appears:

> Use only mcp-dev-runtime's exec_command to run pwd and printf 'mcp-ready\n'. Return actual output and the exit code. Do not modify files or read environment variables or secrets.

The response should contain the working directory, `mcp-ready`, and a final command `exit_code` of `0`. Expand tool details to confirm a real call occurred; the model merely saying “connected” is not verification. If the state is still `running`, continue reading the original `session_id` rather than starting the command again.

After this passes, provide an explicit project directory and task. To revisit logs on another day, set `capture_output: true` when starting that task. Default history metadata does not mean all raw output is saved. See [history and recovery](HISTORY_AND_RECOVERY.md).

To check the refreshed options using harmless output, send:

> Use mcp-dev-runtime to run printf 'setup-line-1\nsetup-line-2\n' with label setup/first-check and capture_output true. Query scope history for that label. Use the returned session_id and archive_id to read tail_lines 1, then search for line-2. Do not change source files or read secrets.

Expect an archive with no truncation, a last line of `setup-line-2`, and a matching search entry. This test explicitly records only the generated marker text. Missing optional arguments require an app-details tool refresh, not creating another API key. See [OpenAI's connect/test and refresh instructions](https://developers.openai.com/plugins/deploy/connect-chatgpt).

**Checkpoint:** this conversation has actually called your computer and returned the expected marker and exit code.

<a id="troubleshooting"></a>
## Troubleshoot by symptom

| Symptom | What to check first |
| --- | --- |
| `./install.sh: Permission denied` | Run `bash install.sh` from the trusted source directory, or restore the executable bit with `chmod +x install.sh`. Some ZIP/extraction paths drop Unix mode bits. |
| Developer mode is missing | Compare both step-1 routes; check the web interface, workspace and account permissions. Ask an administrator rather than repeatedly reinstalling. |
| App form has no Tunnel option | Confirm this is a developer MCP app, not custom GPT Actions; check current official guidance and workspace access. |
| API keys page has no create button or Tunnels scopes | Confirm the organization-level API keys entry point, selected organization and permissions. |
| Tunnel exists in Platform but not in ChatGPT | Check target-workspace association, Read + Use, and permission propagation. Organization association alone may be insufficient. |
| Invalid Tunnel ID | Copy all of `tunnel_` plus 32 lowercase hexadecimal characters, without an ellipsis. |
| 401 / invalid API key | Check the complete non-revoked key and authorized context, not an admin key, name, or masked preview. |
| 403 / Tunnels access required | Separate Manage for creation from Use for runtime; both the principal and key must be authorized. |
| `No compatible Tunnel binary` | Prepare build dependencies and the locked source as in step 6; do not disable validation. |
| `address already in use` | Check for simultaneous `npm start` and `npm run up`; do not terminate unrelated applications. |
| `fetch failed` or a connection timeout | Distinguish local MCP health from outbound Tunnel network/proxy/TLS failures. Read the specific service's logs; do not disable certificate verification to silence the error. |
| Scan Tools fails | Keep MCP and Tunnel running; run local `status`, `doctor`, and `smoke`; check that MCP auth was not mistakenly set to OAuth. |
| Chat says it cannot use the tool | Select the app for this conversation, check enabled tools and authorization prompts, and verify an actual tool result. |
| New arguments are absent | Reload upgraded server code, then refresh the app's cached tool definitions; try a new conversation as needed. These are separate steps. |
| Editing runtime.env has no effect | Exported nonempty variables take precedence; a running service does not hot-reload its configuration. Restart only after checking active work. |
| A real secret was pasted into chat, Git or a screenshot | Revoke/replace the key, update private configuration and verify the replacement. Deleting the visible text alone does not invalidate the exposed secret. |

For local logs, use `tail -n 50 .runtime/mcp.log .runtime/tunnel.log`. Logs, workspace IDs, and command output may still contain private information. Review and redact before public support requests; do not upload the whole directory. See the [troubleshooting reference](TROUBLESHOOTING.md).

These are this project's logs. A terminal running `desktop-commander remote` belongs to a separate application. An error there is not automatically a failure of this connection. Never repeat an unknown side-effecting command solely because its network response was lost.

## Next use, upgrades, and stopping

You do not need to recreate the app each time. After restarting the computer, run `npm run up -- --env-file runtime.env --background` from the project directory and check readiness. No boot service is installed by default. Before stopping, confirm there is no active task you need to keep, then run `npm run down`; it stops the managed services and their tasks.

For code or tool updates, follow [README operations](../README.md#operations). Keep the local service online when choosing Refresh in ChatGPT's app details. Verify optional arguments such as `label`, `capture_output`, `scope`, `archive_id`, `tail_lines`, and `search`; there is no need to enter or reveal a key during this check.

## Images and official references

The three images are unmodified copies from the OpenAI tunnel-client documentation at a fixed revision. They are stored in this repository so normal checkouts and source archives can display them without initializing the Git submodule. They are reference illustrations, not proof of your account's current interface; no generated image is presented as a product screenshot. See [image provenance and license](images/openai/README.md).

Official references: [developer mode](https://developers.openai.com/api/docs/guides/developer-mode), [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), [app and workspace permissions](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt), [tunnel permissions and keys](https://github.com/openai/tunnel-client/blob/master/docs/permissions.md), and [upstream onboarding](https://github.com/openai/tunnel-client/blob/master/docs/onboarding.md). Open sign-in-required pages in your own browser; this document does not claim that anyone has signed in, created a key, or changed organization permissions on your behalf.
