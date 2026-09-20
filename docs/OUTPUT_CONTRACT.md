# MCP 工具输出契约

适用版本：1.0.1 / 契约 3.1。六个工具名称和原有正常调用方式不变，追加历史、筛选与日志查询参数；结构化 `output` 和原有文本格式继续保留。严格缓存输出 Schema 的客户端应刷新工具定义。

## 结构与传输

输出 Schema 描述 `structuredContent`，不是 JSON-RPC 信封或整个工具结果。命令结果的 `structuredContent.output` 保存本次有界日志片段；`content` 中的文本首行仍为不含 `output` 的元数据 JSON，换行后是完全相同的日志片段。客户端只保留结构化结果时，也能读取命令正文。图片仍通过真实 `ImageContent` 返回，图片 base64 不复制到结构化结果。

命令调用方优先读取 `structuredContent.output`；仅在兼容旧服务、该字段不存在时，才从首个文本块的第一个换行之后读取日志。不要拼接两个通道，否则会重复日志。正常执行结果即使没有输出，也明确返回 `output: ""`；执行前置错误仍只有 `error`，不伪造执行结果。

两个通道复用同一次日志读取的结果，不重复执行命令、读取缓存或推进游标。兼容性代价是完整 MCP 响应序列化时多携带一份本次日志片段，而不是复制整个历史日志。`max_output_tokens` 限制的是单个原始日志片段的近似字节预算，不是包含 JSON 转义、元数据和双通道副本的整个响应大小。

所有输出根节点为 object，以兼容现代 MCP 与旧式 initialize 客户端。正常分支要求完整元数据；前置失败分支仅含 `error`，不能用一个空对象或不完整的成功字段通过校验。工具执行失败继续使用 `isError=true`，不会把失败包装为成功。

## 六工具结果

| 工具 | 结构化结果 |
| --- | --- |
| exec_command / write_stdin | output 日志片段、执行标识、实例、状态、实际退出码和信号、工作目录、时间、日志游标、缺口与预算 |
| apply_patch | applied、partial、实际 changes、created_directories 和 warnings |
| view_image | 路径、实际 MIME、返回尺寸、原始尺寸、编码大小及 resized |
| list_exec_sessions | 实例、会话列表及分页游标；条目包含执行状态和日志位置 |
| terminate_exec_session | 执行元数据和 termination_confirmed；未观察到退出时为 false |

`running` / `terminating` 的退出码和结束时间必须为 null。`exited` 表示进程已退出，不等于检查一定通过；需要同时检查退出码和日志。`start_failed` 仍返回会话元数据和错误，供诊断和查询使用。

`has_more` 只描述已经捕获但未返回的日志，不描述进程是否结束。`output_gap=true` 表示请求位置的一部分日志已经淘汰。游标计量 UTF-8 日志字节，不计元数据文本。

## 错误与部分修改

普通错误保持 `{ "error": { "code": "...", "message": "..." } }`。错误对象可包含对应操作的附加诊断；顶层对象禁止未声明字段。没有任意新建统一 status 或 success 字段，避免破坏既有客户端。

补丁执行过程中发生部分修改时，`error.code` 为 `PARTIAL_APPLY`，并保留 `error.applied=false`、`error.partial=true`、`error.changes`、`error.failed_path`、`error.created_directories` 和 `error.warnings`。这些字段明确规定为必填，不能只保留错误消息而丢失已经发生的变更。

多文件补丁仍不具备跨文件事务保证；增加 Schema 不改变这一事实。

## 校验与回归

服务启动时一次性编译 Schema，向 SDK 同时注册 inputSchema 和 outputSchema。已安装 SDK 对正常结果执行输出校验，对 isError 结果可跳过校验，因此测试必须额外显式验证错误数据，不能只检查调用未抛异常。

`tests/unit/output-schema.test.mjs` 校验实际运行时结果以及反向构造的不合法字段，包括空日志、缺失或错误类型的 output、重试和显式重放。`tests/protocol/output-schema.test.mjs` 检查 HTTP、stdio、旧协议兼容、只保留结构化结果的客户端、Unicode 分段续读，以及 SDK 对不合法正常结果的拒绝行为。公共断言逐次检查文本和结构化日志一致。部分写入失败通过仅存在于测试中的故障注入复现，不向 MCP 暴露故障参数。

`npm run verify:deployed` 校验部署实例公布的六个输出定义，并逐次验证实际返回值。测试仅操作自建临时目录。

## 升级

执行 `npm run test:all`、`npm run build` 后，在没有活动任务时重启 MCP。无需更改 Tunnel 配置。ChatGPT 保存的工具定义需在应用设置中刷新；服务端测试不能代替网页是否已刷新成功的确认。

## 依据

- MCP 工具与输出结构：https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- OpenAI Plugin 工具描述：https://developers.openai.com/plugins/reference
- 本项目的实际返回实现：src/runtime/runtime.ts、exec-manager.ts、patch-engine.ts、image-reader.ts。

## 3.1 历史与查询扩展

执行结果可含 label、archive_id、history_state 和 history_warning。磁盘读取返回 source=history、archive_output_bytes 与 archive_truncated；未确认的旧记录 state=unknown，exit_code / signal / ended_at 均为 null。metadata-only、存档缺失、损坏与只读约束有明确错误码。

尾部输出仍是原始连续字节片段。搜索的 output 为空，matches 中包含有限预览与字节位置，继续位置使用 search_next_cursor。两种查询不接收输入，也不改变原有默认输出游标。执行总输出字节数可能大于有界存档实际保存的字节数；详见 HISTORY_AND_RECOVERY.md。
