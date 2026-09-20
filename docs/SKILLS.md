# Local Skills (experimental, v1.1.0)

[简体中文](SKILLS.zh-CN.md)

Introduced in v1.1.0, this feature adds two **opt-in,
read-only MCP tools**: `discover_skills` and `read_skill`. The default tool list
remains the existing six tools. No model, agent, Codex process, dependency
installer, network search, or script is launched by either Skill tool.

## Enable and observe

Merge these fields into your **existing** unified `config.json`; do not replace
ports, directories or credentials. The `skills` section is optional when empty.

```json
{
  "tools": {
    "allow": [
      "exec_command",
      "write_stdin",
      "apply_patch",
      "view_image",
      "list_exec_sessions",
      "terminate_exec_session",
      "discover_skills",
      "read_skill"
    ]
  },
  "skills": {
    "extra_roots": [],
    "disabled_paths": []
  }
}
```

`mdr config --json` reports effective non-secret settings; `mdr tools` reports
which tool policies are enabled. A legacy split installation can use the same
optional `skills` section in its runtime config. Its existing path/lifecycle
semantics are unchanged. Skill configuration paths, including `~/...`, resolve
relative to the selected configuration file in either format.

After deliberately enabling tools, stop/restart the selected installation only
when its active work can be interrupted, then refresh the app's tools in ChatGPT
and test in a new conversation. No source build, test or upgrade automatically
enables these tools or switches the user's running instance. Removing the two
names and restarting disables the feature. Do not change the six existing tools
merely to enable Skills. Skill files themselves need no restart: refresh or
cache revalidation finds changes.

## When does the model use a Skill?

With both tools enabled, a short MCP `instructions` prefix tells the current
model to check once for each new substantive local project task. An explicitly
named skill can be read directly without a discovery round trip. After selection,
read `SKILL.md` completely, following every `next_cursor` before task actions.
Read referenced instruction files only when relevant, but read selected necessary
instructions completely. Reuse guidance only while applicable and present in the
current model context. Simple reads/status checks, output polling and mechanical
continuations do not require another search. No relevant match means normal tools
remain available.

This is **host-model guidance, not a mandatory turn hook**. A MCP server does not
receive every user message, cannot prove what a conversation remembers, and does
not intercept `exec_command` to force discovery. It does not require ChatGPT's
native Skill-upload UI or a plugin import extension. SDK tests verify discovery,
reads and tool execution, not the hosted model's implicit trigger rate or its
semantic choice accuracy. Those need separate, real ChatGPT acceptance tests.

Enabling only one Skill tool does not enable the other. The combined workflow
instruction is only advertised when both are available.

## Tool contracts

`discover_skills` requires an absolute, existing target `workdir`. With `query`,
it returns ranked metadata (never instruction bodies). Include a concise task
intent and relevant framework/technical terms. For Chinese requests about English
Skill descriptions, the current model may include English technical keywords;
the server itself performs no translation/model call. Without `query`, it browses
the catalog, including explicit-only entries. Defaults: `limit=5`; at most 20
entries, also subject to the byte budget. `refresh=true` rechecks disk. Repeat the
same workdir/query with `next_cursor`; do not combine a cursor and refresh.

```json
{
  "workdir": "/absolute/path/to/project",
  "query": "SolidJS panel animation spring transition",
  "limit": 5
}
```

Results distinguish `catalog_complete=false` (limits or inaccessible/invalid
sources) from a complete catalog with no relevant results. `description_truncated`
and `origin_truncated` explicitly mark shortened display metadata; matching uses
the validated full metadata. `next_cursor` means more results remain. Scores are
ranking weights, not probabilities; the model makes the final applicability
decision. Exact-name relevance wins, then weighted BM25 with Han bigram tokens;
ties retain deterministic project-before-global discovery order.

`read_skill` requires workdir and a discovered `skill` ID, or an exact unambiguous
name. `resource` defaults to `SKILL.md`. IDs are identities, not permissions: a
project Skill ID from a different workdir is not accepted. Duplicate names cause
`AMBIGUOUS_SKILL` and require the exact ID. Explicit user selection may set
`explicit=true` for a Skill that disallows implicit use. This assertion is not a
new user-authorization credential.

```json
{
  "workdir": "/absolute/path/to/project",
  "skill": "name-of-an-existing-skill",
  "resource": "SKILL.md"
}
```

Resources such as `references/solid.md` and `scripts/check.sh` resolve from
`skill_root`, **not** the project workdir. Only bounded regular UTF-8 text is read;
no resource or script is executed. Use the original tools for authorized actions,
quoting paths normally. URLs, absolute resource paths, hidden components, traversal,
escaping links, devices and FIFOs are rejected. Binary assets can be inspected
with an appropriate existing tool, not silently converted to instruction text.

The result contains `revision`, `contents`, `content_complete` and `next_cursor`.
Repeat workdir/skill/resource/explicit when following a cursor. Continuations are
signed and bound to the server instance, workdir, selected resource and snapshot.
File or policy changes produce `SKILL_CHANGED`; expired/evicted snapshots produce
`CURSOR_EXPIRED`. Start again rather than concatenate different revisions. The
server never suppresses instructions because some other conversation read them.

## Discovery and compatibility

Global roots: `~/.agents/skills`, `$CODEX_HOME/skills` (default `~/.codex/skills`),
and its existing `.system` compatibility directory. Relative or invalid
`CODEX_HOME` is ignored with a notice. No Codex installation or bundled-skill
download is performed.

Project roots: `.agents/skills` and `.codex/skills` at the target directory and
each ancestor through the nearest `.git` file/directory. A Git worktree marker is
supported. Without a marker, only the explicit workdir is treated as the project
boundary. `.codex/skills` project discovery is an MDR compatibility feature, not a
promise to duplicate every Codex configuration layer. No full-home or full-disk
search is performed.

Collections can contain nested skills; finding `SKILL.md` marks a package boundary,
so its scripts/references/assets are not recursively scanned as separate skills.
Hidden descendants and generated dependency directories are skipped. Directory
symlinks are supported, cycle-bounded and deduplicated by canonical file identity.
Different files with the same name remain distinct. Disabling a file/directory
also excludes its resolved aliases. Additional roots are explicit configuration.

Metadata uses bounded YAML frontmatter. `name` may fall back to the directory
name for Codex compatibility; a nonempty description is required. Multiline YAML
is supported; duplicate keys, custom tags and alias graphs are not accepted.
Invalid skills are isolated and reported without dumping parser input.
`agents/openai.yaml` supports `policy.allow_implicit_invocation`, optional short
description and bounded `type:value` dependency hints. A malformed/unreadable
sidecar or unverifiable product restriction disables implicit use conservatively.
Dependencies are not provisioned or automatically verified. Other agents' hooks,
permissions, models and Codex-wide disabled settings are not inherited. Use
MDR `disabled_paths` deliberately.

## Budgets, caching and isolation

No Skill service or YAML dependency is loaded until an enabled Skill tool is
called. Disabled tools do not get their schemas compiled, do not get routing
instructions, and cause no directory scan/watcher. Enabling a tool still adds its
fixed schema to the client surface; no claim of zero total startup/token cost is
made. The default six schemas/results/instructions stay unchanged.

The shared Runtime owns the service across stateless HTTP requests. Catalogs and
canonical root scans are shared within that service and separated by workdir;
overlapping initial loads coalesce. A 30-second TTL is checked on the next Skill
request; there is no polling timer or resident recursive watcher. Refresh/rebuild
checks files as well as directories, so in-place edits and new skills are both
detected. Reads revalidate identity and invocation policy even with a warm cache.

| Boundary | Default |
| --- | --- |
| Catalog response JSON | 4 KiB |
| Read response JSON | 24 KiB per page |
| Metadata head/sidecar | 16 KiB |
| Full text resource | 256 KiB |
| Nesting / entries / directories per root | 8 / 10,000 / 2,048 |
| Skills per root / combined catalog | 512 / 1,024, additionally memory-bounded |
| Root/scope/body cache accounting | 12 / 8 / 8 MiB maximum |
| Cached scope count / body count | 16 / 32 |
| Body snapshot lifetime | 10 minutes, or earlier capacity eviction |
| Active Skill requests | 4; excess gets `SKILLS_BUSY` |

Deadlines are cooperative (5 seconds per root traversal, 15 seconds per request);
ordinary OS filesystem calls are not a hard-cancellable sandbox. Cache accounting
does not equal an absolute process RSS limit; parsing and in-flight results need
bounded temporary allocations. Ordinary execution neither waits for the catalog
nor takes a Skill lock. Saturation/failure of Skill requests does not consume an
execution-session slot.

The JSON payload is mirrored in one MCP text block and `structuredContent` for
client compatibility. Wire size is therefore approximately twice the payload
plus envelope/escaping overhead; neither byte budget is an exact model-token
count. Do not repeatedly reread instructions already fully present and applicable
in the current task. Do not claim a local cache hit eliminates model-side tokens.

## Safety and validation

Skill text is untrusted task guidance, never higher-priority policy. It cannot
grant permission to publish, delete, upload data, call another agent/model, or
override the user's instructions. Reading selected Skill text sends it to the
connected model; avoid storing secrets in Skill documents. Logs contain tool name
and elapsed time at debug level, not whole queries or documents. The tool
allowlist is not an OS sandbox: an enabled shell still has the service user's
existing access. MDR uninstall never owns or recursively removes the default
shared `~/.agents/skills` / `~/.codex/skills` directories.

Run `npm run test:all`, `npm run verify:cli`, `npm run release:check`, and
`npm run benchmark:skills`. New tests use temporary homes/projects. The package
verifier checks opt-in Skills using the bundled Node/YAML in isolated stdio while
the usual six-tool acceptance flow remains default-only. No tests connect real
Tunnel credentials or install/execute a user's private Skill.

Hosted acceptance is separate: refresh tools, start a new chat, test new complex
tasks without mentioning Skills, explicit names, no-match cases, repeated
continuations and project switches. Record misses, wrong selections, repeated
reads, end-to-end delay and actual visible context. A local SDK pass is not a
claim of identical Codex/ChatGPT success rate.
