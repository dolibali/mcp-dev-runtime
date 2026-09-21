# MCP Dev Runtime tool reference

Project 1.2.0 keeps the six default stable tool names and contract 3.1 behavior, with optional history, filtering and log-query arguments. Launcher commands are CLI operations, not additional MCP tools. Native Windows uses a separate execution backend; its shell, cancellation and directory semantics are documented in [WINDOWS.md](WINDOWS.md).

# 工具接口参考

接口名称和输入约束来自 contracts/tools.json。所有路径支持绝对路径；相对路径以显式 workdir 或固定服务 cwd 解析。本文不增加未实现的工具。

Two optional experimental tools are available in v1.1.0: `discover_skills` and `read_skill`. They remain disabled by default and do not change the six stable tool contracts. See [Local Skills](SKILLS.md) / [中文说明](SKILLS.zh-CN.md).

## exec_command

Execute a command on the host using a shell. Ordinary commands use pipes; tty=true provides interactive PTY input. Return output, state and a session_id; continue running commands with write_stdin instead of launching them again. Files, search, Git, builds and tests are available through installed commands. No Codex agent or model is called.

| 参数 | 类型 | 必填 | 约束与说明 |
| --- | --- | --- | --- |
| `cmd` | string | 是 |  Shell command to execute. |
| `workdir` | string | 否 |  Working directory. Relative values resolve against the fixed server cwd; omitted uses that cwd. |
| `shell` | string | 否 |  Optional absolute shell executable path; omitted uses the shell resolved at server startup. |
| `login` | boolean | 否 | default=false Use a login shell. False avoids loading login startup files for each command. |
| `tty` | boolean | 否 | default=false Allocate a PTY when input or terminal semantics are required. Otherwise stdin is closed and output uses pipes. |
| `yield_time_ms` | integer | 否 | default=1000; minimum=0; maximum=10000 Maximum wait for this initial response, not a process timeout. Completed commands return immediately; a still-running command returns when this wait expires. |
| `max_output_tokens` | integer | 否 | default=4000; minimum=256; maximum=16000 Approximate text budget: at most min(4 * value, 65536) UTF-8 bytes. Not an exact model token count. |
| `timeout_ms` | integer | 否 | minimum=1; maximum=2147483647 Optional total process lifetime in milliseconds. Omitted means no automatic execution deadline. |
| `request_id` | string | 否 |  Optional per-instance retry key. Reuse only for the identical operation; valid while its record is retained. It is not the JSON-RPC id. |

## write_stdin

Send characters to an existing PTY session or poll output with empty chars. Read process state and exit_code to determine completion. An ended session may still contain unread output. Non-empty input to pipe sessions fails with STDIN_CLOSED. Use longer bounded waits for quiet long tasks; do not launch the command again.

| 参数 | 类型 | 必填 | 约束与说明 |
| --- | --- | --- | --- |
| `session_id` | integer | 是 | minimum=1; maximum=9007199254740991 Execution handle returned by this server, not an OS PID or MCP connection id. |
| `chars` | string | 否 | default="" Characters to write; empty means read only. Control characters retain PTY semantics. |
| `yield_time_ms` | integer | 否 | minimum=0; maximum=10000 Maximum wait for this response only; not a process timeout. Return earlier when output or completion is available. Omitted defaults to 250 ms for input, 5000 ms for empty polls. |
| `max_output_tokens` | integer | 否 | default=4000; minimum=256; maximum=16000 Approximate text budget: at most min(4 * value, 65536) UTF-8 bytes. Not an exact model token count. |
| `output_cursor` | integer | 否 | minimum=0; maximum=9007199254740991 Explicit UTF-8 log byte offset. Omitting uses and advances the session default cursor; an explicit read does not advance that default. |
| `request_id` | string | 否 |  Optional per-instance retry key. Reuse only for the identical operation; valid while its record is retained. It is not the JSON-RPC id. |

## apply_patch

Edit files using the Codex-style *** Begin Patch / *** End Patch format, provided as the JSON patch string. Supports Add File, Update File, Delete File, Move to and multiple hunks. Not git unified diff and not a freeform MCP argument. Existing Add/Move destinations are rejected. Multi-file changes are not atomic; inspect partial failures.

| 参数 | 类型 | 必填 | 约束与说明 |
| --- | --- | --- | --- |
| `patch` | string | 是 |  Complete patch text, including envelope and line prefixes. |
| `workdir` | string | 否 |  Working directory. Relative values resolve against the fixed server cwd; omitted uses that cwd. |
| `request_id` | string | 否 |  Optional per-instance retry key. Reuse only for the identical operation; valid while its record is retained. It is not the JSON-RPC id. |

## view_image

Read an existing host image and return actual MCP image content. Supports PNG, JPEG and WebP, with configured size limits and optional resizing. It does not take screenshots or open a browser. Relative image paths resolve within workdir or the fixed server cwd.

| 参数 | 类型 | 必填 | 约束与说明 |
| --- | --- | --- | --- |
| `path` | string | 是 |  Path to an existing image. |
| `workdir` | string | 否 |  Working directory. Relative values resolve against the fixed server cwd; omitted uses that cwd. |

## list_exec_sessions

List execution records owned by this server instance, including running and recently ended commands. Use this MCP extension to recover a handle after a disconnected request. It does not list ChatGPT conversations, Codex threads or unrelated OS processes. After a lost initial response, use write_stdin with output_cursor=0 to recover retained output; check output_gap.

| 参数 | 类型 | 必填 | 约束与说明 |
| --- | --- | --- | --- |
| `state` | string | 否 | enum=["running", "exited", "terminating", "terminated", "timed_out", "start_failed"] Optional state filter. |
| `limit` | integer | 否 | default=20; minimum=1; maximum=100 Maximum records returned per page. |
| `cursor` | string | 否 |  Opaque next-page cursor returned by a previous call. |

## terminate_exec_session

Request termination of a command created by this server. Works for both pipe and PTY sessions. force=true skips the graceful signal stage. A terminating response is not proof of exit; poll until an observed terminal state. Already-ended records keep their existing terminal result.

| 参数 | 类型 | 必填 | 约束与说明 |
| --- | --- | --- | --- |
| `session_id` | integer | 是 | minimum=1; maximum=9007199254740991 Execution handle returned by this server, not an OS PID or MCP connection id. |
| `force` | boolean | 否 | default=false Skip graceful termination and request forced termination. |
| `request_id` | string | 否 |  Optional per-instance retry key. Reuse only for the identical operation; valid while its record is retained. It is not the JSON-RPC id. |

## 结果约定

工具成功结果使用 `content` 和 `structuredContent`。命令的首个文本块仍为一行 JSON 元数据、换行、实际输出；`structuredContent` 同时包含元数据和 `output`，即本次相同的有界日志片段。优先读取 `structuredContent.output`，不要再与文本通道拼接。这样只暴露结构化结果的客户端也不会丢失正文；图片 base64 不复制到结构化结果。

`exec_command` / `write_stdin` 返回 output、session_id、instance_id、state、exit_code、signal、tty、workdir、时间字段、输出游标及预算说明。正常结果的 output 始终为字符串，包括没有输出时的空字符串。非零退出是实际命令结果，isError=false；启动失败、未知会话、无效补丁等工具故障使用 isError=true。传输/JSON-RPC 错误与工具故障是不同层次。

状态为 running、exited、terminating、terminated、timed_out 或 start_failed。退出码只有在被实际观测时才返回；信号退出或启动失败可以为 null。开始终止不等于终止完成。

输出字段：output 为本次日志片段，output_start 为本次实际起点，next_output_cursor 为下一次字节偏移，has_more 表示保留缓冲仍有未读内容，retained_from 表示最早保留偏移，output_gap 表示请求起点已经被淘汰。显式游标不会推进默认游标，向两个返回通道提供同一片段也不会二次推进游标。输出预算不包含元数据、JSON 转义和兼容副本的序列化开销。

补丁成功返回 applied=true、partial=false、changes、created_directories、warnings；失败后的部分变更在 error 中返回 applied=false、partial=true、changes、failed_path、created_directories 和 warnings。临时文件清理告警不会把已提交的文件变更伪装成完全未执行。

图片返回真实的 image 内容块和独立文本/结构化元数据。客户端需支持 MCP 图片内容；路径和普通 base64 文本不是图片验收结果。

## 输出结构（契约 3.1）

所有工具在 `tools/list` 中声明 `outputSchema`，且与 `structuredContent` 一致。定义同时涵盖正常元数据和仅含 `error` 的失败结果；进程启动失败保留执行标识及元数据。补丁部分失败的变更记录仍位于 `error.changes`。完整字段和兼容约定见 [输出契约](OUTPUT_CONTRACT.md)。

## 契约 3.1 新增可选参数

| 工具 | 新参数 | 用途 |
| --- | --- | --- |
| exec_command | label、capture_output | 任务标签；按需从执行开始保存原始日志 |
| write_stdin | archive_id、tail_lines、search、max_matches | 历史日志、只读尾部查看、字面搜索 |
| list_exec_sessions | scope、workdir、label、outcome、order | 内存或磁盘历史查询和筛选 |

搜索结果使用 matches、search_next_cursor、search_has_more；不会伪装成连续的 output 或推进默认输出游标。历史结果可包含 unknown 状态，表示旧实例最终结果未确认，不能据此恢复进程。完整语义见 [执行历史与恢复](HISTORY_AND_RECOVERY.md)。
