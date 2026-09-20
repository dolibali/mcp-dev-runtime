# 本机 Skill（实验性，v1.1.0）

[English](SKILLS.md)

本功能自 v1.1.0 提供，新增两个需要主动启用的
**只读 MCP 工具**：`discover_skills`、`read_skill`。默认仍是原来的六个工具。
两个新工具不启动 Codex、第二个 Agent 或模型，不安装依赖、不联网搜索，也不执行脚本。

## 启用与查看

把下面字段合并进**已有的**统一 `config.json`，不要覆盖端口、目录和其他设置。
没有额外目录和禁用项时，`skills` 分组可以省略。

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

`mdr config --json` 显示实际非敏感设置，`mdr tools` 显示启用状态。
旧 split 安装也可在 runtime 配置中使用这两个可选字段，不改变旧路径和生命周期语义。
新增加的 Skill 配置路径支持 `~/...`，在两种配置格式中都相对所选配置文件解析。

主动启用后，先确认任务允许中断，再重启所选安装，在 ChatGPT 中刷新工具并用新对话测试。
开发、构建、测试都不会替用户启用功能、迁移配置或重启正在使用的实例。
从白名单删除两个名称并重启即可关闭。Skill 文件变化本身不需要重启：刷新或缓存复核会发现。

## 什么时候主动用 Skill？

两个工具一起启用时，服务器在 MCP `instructions` 的前部提供短规则：新的实质性项目任务
开始时，按目标 `workdir` 查询一次；用户明确指定名称时可以直接读取。选中后，先完整读取
`SKILL.md`，有分页就跟随全部游标，再开展对应任务动作。只读取与任务相关的参考资料，
但必要指令文件不能只读一部分。同一任务中，只在内容仍完整保留且适用时复用。
简单状态检查、日志轮询和机械续步不重复搜索；没有匹配则直接使用原工具。

这是**对当前宿主模型的指导，不是强制的每轮钩子**。MDR 收不到每一条用户消息，也不知道
上下文是否被压缩，不会拦截 `exec_command` 强行插入搜索。不依赖原生 Skill 上传入口或插件导入扩展。
本地 SDK 测试能证明发现、读取和执行正确，不能证明网页版模型的隐式触发率；后者单独验收。
只开启一个新工具不会自动开启另一个，完整的发现—读取指导只在两者可用时提供。

## 两个工具

`discover_skills` 必须提供绝对、已存在的目标工作目录。提供 `query` 时检索元数据，不返回正文；
中文任务可以由当前模型补充少量英文技术词，服务端不额外调用模型翻译。
不提供 `query` 时分页浏览，也能看见需要显式选择的技能。默认最多 5 个结果，最大 20 个，
还受响应字节预算约束。`refresh=true` 重新检查磁盘，不与分页游标同时使用。

```json
{
  "workdir": "/absolute/path/to/project",
  "query": "SolidJS panel animation spring transition",
  "limit": 5
}
```

`catalog_complete=false` 表示目录不可读、格式错误或达到扫描限制，不等于“完整扫描后没有匹配”。
`description_truncated` / `origin_truncated` 明确标记显示字段被缩短；检索使用通过验证的完整元数据。
`next_cursor` 表示还有下一页，续查保持相同的 workdir/query。分数只是排序依据，不是适用概率。
名称精确匹配优先，其后采用字段加权 BM25 和中文字符二元组；同分时保留确定性的项目优先顺序。

`read_skill` 提供 workdir 和已返回的技能 ID，也可直接使用准确、无歧义的名称。
`resource` 默认 `SKILL.md`；跨项目 ID 不会成为绕过范围的读取凭证。
重名返回 `AMBIGUOUS_SKILL`，应根据来源选 ID。只有用户确实点名时，才可使用
`explicit=true` 读取不允许隐式使用的 Skill；此字段不是扩展操作权限的授权。

```json
{
  "workdir": "/absolute/path/to/project",
  "skill": "name-of-an-existing-skill",
  "resource": "SKILL.md"
}
```

`references/solid.md`、`scripts/check.sh` 等路径相对 `skill_root`，**不是**项目 workdir。
工具只读取有界的常规 UTF-8 文本，不执行资源。授权操作仍由原六工具完成，执行时正确引用路径。
拒绝 URL、绝对资源路径、隐藏路径、`../` 越界、越界链接、设备和 FIFO；二进制资产不伪装成指令文本。

结果包含 `revision`、`contents`、`content_complete`、`next_cursor`。
分页保持相同 workdir/skill/resource/explicit；游标绑定实例、工作范围、资源和内容快照。
内容或策略更新返回 `SKILL_CHANGED`；缓存过期或淘汰返回 `CURSOR_EXPIRED`。
应该重新读取，不能混合不同版本的页面。服务器不会因为另一个对话读过，就省略当前对话需要的正文。

## 发现目录与兼容性

全局自动检查 `~/.agents/skills`、`$CODEX_HOME/skills`（未设置时是 `~/.codex/skills`），
以及后者已经存在的 `.system` 兼容目录。相对或非法 CODEX_HOME 会被忽略并提示。
不会安装 Codex 或下载内置 Skill。

项目检查目标目录到最近 `.git` 文件/目录之间各级 `.agents/skills` 和 `.codex/skills`，支持 worktree。
没有仓库标记时，只有明确 workdir 作为项目边界，不扫描整个主目录或硬盘。
项目 `.codex/skills` 是 MDR 的兼容扩展，不代表复制 Codex 的全部配置层。
找到 `SKILL.md` 后视为包边界，不把其 references/scripts/assets 继续当成技能集合扫描。

支持技能目录符号链接、循环检测、真实路径去重。相同文件多个入口合并，同名不同文件保留独立 ID，
不默默拼接或覆盖正文。禁用文件/目录也会排除其可解析别名；额外根目录必须明确配置。

元数据使用受大小限制的 YAML。为兼容 Codex，缺少 name 可回退到目录名；description 必须非空。
支持多行文本，不接受重复键、自定义标签和 alias 图。错误技能单独跳过，不输出 YAML 原文到错误日志。
`agents/openai.yaml` 支持隐式使用策略、短描述、有限的 `type:value` 依赖提示。
sidecar 格式错误、不可读或产品限制无法验证时，保守禁止隐式推荐。
依赖不会被自动安装或验证；不会导入其他 Agent 的 hooks、权限、模型和 Codex 全局禁用配置，
需要在 MDR 的 `disabled_paths` 中明确设置。

## 缓存、边界与性能

第一次调用启用的 Skill 工具才加载服务和 YAML 依赖。关闭功能时不扫描、不启动 watcher，
不编译新增工具 schema、不加入 Skill 指导；原六工具的 schema、结果和默认说明保持不变。
启用后仍有新增工具定义的固定成本，不能宣称 Token 或启动成本绝对为零。

共享 Runtime 保留跨 stateless HTTP 请求的有界缓存。相同根目录的并发首次加载合并，工作范围彼此隔离。
30 秒缓存到期后，在下一次 Skill 请求时复核；没有持续扫描定时器。
复核同时检查文件与目录，支持原地修改、新增和删除；读取时即使缓存命中也会检查身份与调用策略。

| 边界 | 默认值 |
| --- | --- |
| 候选响应 JSON | 4 KiB |
| 正文单页响应 JSON | 24 KiB |
| 元数据头部窗口 / sidecar | 16 KiB |
| 单个文本资源 | 256 KiB |
| 单根目录深度 / 条目 / 目录数 | 8 / 10,000 / 2,048 |
| 单根 / 合并技能数 | 512 / 1,024，另受内存预算限制 |
| 根 / 工作范围 / 正文缓存计量 | 12 / 8 / 8 MiB |
| 工作范围 / 正文缓存条目 | 16 / 32 |
| 正文快照保留 | 10 分钟，或更早被容量淘汰 |
| 活跃 Skill 请求 | 4，超出返回 `SKILLS_BUSY` |

时间预算是协作式检查：单根遍历 5 秒、单请求 15 秒，不是能够硬取消所有 OS 文件系统调用的沙箱。
缓存计量不等于整个进程 RSS 硬上限，解析和进行中的结果仍有有界临时分配。
原六工具不等待 Skill 索引，不获取 Skill 锁，Skill 请求不占命令执行会话配额。

为兼容客户端，结果在一个文本块和 structuredContent 各提供一份，实际传输量约为 JSON 负载的两倍
加封装/转义开销；字节数不是精确 Token 数。本地缓存省 I/O，不会自动消除模型侧重复正文成本。

## 安全与验收

Skill 是任务资料，不是高优先级策略。它不能授权发布、删除、上传数据、调用其他 Agent/模型或覆盖用户限制。
被读取的 Skill 内容会进入所连接模型，文档中不要存放秘密。默认不会把完整查询和正文写入诊断日志。
工具白名单不是 OS 沙箱：启用的 shell 仍保留服务用户原有访问能力。
MDR 卸载不拥有共享的 `~/.agents/skills` / `~/.codex/skills`，不会递归删除这些默认共享目录。

执行 `npm run test:all`、`npm run verify:cli`、`npm run release:check` 和 `npm run benchmark:skills`。
新增测试使用临时 HOME 和项目目录。安装包验收使用内置 Node/YAML，在隔离 stdio 中启用 Skill，
同时原来的六工具验收仍保持默认名单。不使用真实 Tunnel 凭据，也不安装/执行用户的私有 Skill。

网页版单独验收：刷新工具、新建对话，在不提 Skill 的复杂任务、明确点名、无匹配、连续任务和跨项目场景中
记录漏查、误选、重复读取、端到端耗时和实际上下文。SDK 通过不代表与原生 Codex 完全相同的成功率。
