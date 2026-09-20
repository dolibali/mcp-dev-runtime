# 架构与 Codex 对齐说明

## 1. 数据路径

AI 客户端 → MCP（可经 OpenAI Tunnel）→ 工具注册 → 独立本地运行时 → 文件、Shell、构建和测试进程。

服务只执行工具，不组织模型推理，不建立 Codex thread，也不使用 Responses API。六个工具的名称和核心参数固定在 `contracts/tools.json`，HTTP 与 stdio 使用同一注册函数。

## 2. MCP 与执行会话分离

HTTP 使用官方 TypeScript SDK v2 的 `createMcpHandler`、Node 适配器及无状态旧协议兼容入口。协议实例按请求创建；`Runtime`、`ExecManager` 和 `RetryCache` 在进程启动时创建一次。连接结束不销毁命令，客户端通过显式 `session_id` 续接。

stdio 使用官方 `serveStdio`，同样复用应用运行时。现代 discovery 与旧版 initialize 均由 SDK 处理，不通过手写响应冒充协议支持。

工具正文返回 `content`，状态等字段返回 `structuredContent`。命令的同一有界日志片段同时提供为 `structuredContent.output` 和原有文本正文，兼容仅暴露结构化结果的客户端。两个通道复用一次日志读取，不重新执行命令或推进游标；完整响应的序列化体积会增加一份当前片段，调用方应只消费其中一个通道。图片使用真实 `ImageContent`，不会把图片 base64 再复制到结构化结果。

## 3. 进程和输出

普通命令由 Node `spawn` 启动 Shell，独立 cwd、非交互 stdin、stdout/stderr 持续排空。最终状态依据 `close` 而非仅依据 `exit`，避免遗漏输出尾部。PTY 使用 `node-pty`，保留终端输入、回显、CRLF 和控制字符语义。

输出按字节位置追加到有界日志。缓存以固定块保存，不反复拼接整个输出字符串。读取预算在 UTF-8 字符边界截断；默认游标串行推进，显式游标可重放。同一会话的重叠默认读取或输入返回 `SESSION_BUSY`。

短命令优先等待到完成并返回退出码；长命令达到调用等待上限后返回句柄。总执行超时是独立参数。终止先请求 SIGTERM，再按宽限期升级为 SIGKILL；返回 `termination_confirmed` 的依据是进程退出事件。

## 4. 补丁

`patch-parser.ts` 实现 Begin/End、Add/Update/Delete、Move、上下文定位、多个修改片段和 EOF 标记。匹配依次尝试精确、行尾空白、两端空白及有限 Unicode 标点归一化，与参考实现的主要匹配顺序对齐。它不是任意编辑距离模糊匹配。

引擎先读取和预计算全部目标，再通过提交互斥检查版本并执行。每个文件采用同目录临时文件写入，已有文件更新使用原子替换；多文件操作整体不原子。源文件状态或内容在预计算后变化会被报告，不提供强制覆盖参数。

新增和移动目标已存在时拒绝覆盖。这是本项目明确的实现差异。更新符号链接时更新其目标，删除时删除链接自身；硬链接更新替换指定目录项，不写穿所有链接。新增文件使用正常创建权限，更新保留原文件模式。CRLF、混合换行及缺少末尾换行有回归测试。

## 5. 重试和资源

`request_id` 去重记录在副作用执行前登记，并发同参请求共享同一个 Promise。失败同样缓存；异参重用标识会被拒绝。运行中的缓存条目不因容量压力被淘汰。记录受容量与保留期约束，不跨进程重启持久化。

活动会话数量在异步路径检查之前预留，避免并发启动穿透上限。清理只淘汰结束会话，不通过停止活动任务释放槽位。日志超过总预算时淘汰较旧输出，并通过游标缺口通知读取方。

## 6. 对齐范围与有意差异

| 方面 | 本项目选择 |
| --- | --- |
| 模型调用 | 不存在；Codex 仅作为源码参考 |
| 核心名称 | exec_command、write_stdin、apply_patch、view_image |
| MCP 扩展 | list_exec_sessions、terminate_exec_session |
| apply_patch 入参 | JSON 对象中的 patch 字符串，不采用原生 freeform 通道 |
| 权限字段 | 不暴露 Codex 的审批、沙箱和权限申请字段 |
| 输出 token | 使用标明的字节预算估算，不宣称复刻模型 tokenizer |
| 初次执行等待 | 结束或等待到期返回；后续查询可在新输出到达时返回 |
| 断连恢复 | 同实例应用级会话；不恢复跨服务重启进程 |
| 文件事务 | 单文件原子替换和部分失败报告，不宣称多文件原子性 |

工具命名一致并不证明所有 ChatGPT 模型调用效果与 Codex 相同。接口、参数、实际行为和模型侧说明须一致，真实工作负载上的成功率与延迟应通过独立验收确定。

## 7. 参考基线

Codex 的固定提交、下载的文件清单位于 `reference/codex/SOURCE.json`。运行依赖及完整传递依赖由 `package-lock.json` 固定。参考源码不参与编译，不会被作为本地 Agent 执行。

## 输出契约注册

`contracts/tools.json` 是六工具输入和输出 Schema 的声明源。`src/mcp/server.ts` 在模块加载时编译并缓存两类 Schema，传入 SDK `registerTool`；不会在每个请求中重新编译。SDK 校验正常结果，独立回归测试也显式校验错误分支，避免依赖特定 SDK 是否跳过 `isError` 结果。执行、补丁、输出日志与图片运行时保持原有行为。

## 0.2.0 deployment layer

`src/launcher/` supervises the MCP server and an independent OpenAI Tunnel process. It does not run an Agent, invoke models or change the six-tool protocol. Both the full client and run-only runtime must identify the exact source pin in `tunnel.lock.json`. The optional submodule is a development/build dependency, not required for an installed compatible binary. Lifecycle coordination uses a per-instance local control socket; it does not adopt unrelated processes.

## 0.3.0 retention, persistence and observability

Session TTL is disabled by default and independent from retry-cache TTL and maintenance cadence. Active command creation responses are pinned until observed process completion. Completed sessions retain bounded command previews and release process handles. The hot output path maintains an incremental byte counter rather than summing every retained session on every chunk.

HistoryStore provides a bounded local single-writer archive with atomic metadata replacement, asynchronous opt-in log capture, explicit truncation/failure diagnostics, filtered snapshots and read-only cross-instance lookup. Defaults save metadata without raw command text or output. Logs are captured from the beginning; history does not reconstruct missing cache bytes or revive old processes.

Read-only tail and literal-search selectors share bounded UTF-8-aware query logic for live and archived output. Live and historical queries keep the normal execution cursor independent.

Runtime health now exposes resource, retry and archive diagnostics. Supervisor status includes fresh bounded local MCP/Tunnel probes; transient readiness failures do not restart or repeat commands. Runtime MCP/Tunnel diagnostic streams use asynchronous rotating writers with backpressure. Lifecycle launcher output retains its separate low-volume startup rotation.
