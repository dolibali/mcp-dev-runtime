# Security and responsible use

This runtime executes commands and modifies files with the service user's operating-system access. It does not provide a sandbox, command whitelist, secondary approval system or multi-user isolation. Operate it only in a trusted deployment under your control. Client-side permission prompts do not change OS process privileges.

Returned code, logs and images are delivered to the calling MCP client. Confirm that this is appropriate for your data and accounts. Do not use the tools for unauthorized access, damage or bypassing client/platform safeguards.

Keep runtime keys, local configuration, private logs and backups out of source control. Use your own Tunnel and client application for each deployment. Do not expose an unrestricted developer instance as a public shared service.

A repository owner must configure a private vulnerability-reporting route on GitHub before publication. No contact address is invented here. Never include keys, private source or personal machine logs in a public issue. This document describes the threat boundary and does not claim a security audit or certification.

## Local history (0.3.0)

Disk execution metadata is enabled by default; command text and raw output capture are disabled by default. Explicit labels, workdirs, timing and outcome metadata are still private data. capture_output=true and history.record_output=true can save secrets or terminal input echoes present in stdout/stderr; no universal automatic redaction is claimed. Directories use 0700, files 0600, with bounded record/byte quotas. This is not encryption or a sandbox against the same OS user.

Turning recording off affects future tasks, not old files. history-clear --confirm is an explicit offline operation and refuses an active writer. History recovery never uses stale PIDs to resume or kill processes. Interrupted records are unknown, not fabricated successes. Default history directories are excluded from source exports.
