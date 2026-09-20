# 预编译版安装

[English](BINARY_INSTALL.md) | **简体中文**

[v1.1.0 发行页](https://github.com/dolibali/mcp-dev-runtime/releases/tag/v1.1.0)提供四种平台运行包。每包内置 Node.js 24.21.0、编译后的应用、对应平台的原生依赖，以及按照 `tunnel.lock.json` 精确 commit 构建的 runtime-only Tunnel。安装和运行 MDR 不要求系统另装 Node、npm、Git、Go 或编译器；你自己的开发项目需要的工具仍由自己的环境提供。

## 选择并校验下载文件

| 压缩包后缀 | 平台 / 原生验证基线 |
| --- | --- |
| `darwin-arm64.tar.gz` | Apple Silicon，macOS 14 |
| `darwin-x64.tar.gz` | Intel Mac，macOS 15 |
| `linux-x64-gnu.tar.gz` | x64，Ubuntu 22.04，glibc 和 GCC 12 的 libstdc++ |
| `linux-arm64-gnu.tar.gz` | ARM64，Ubuntu 22.04，glibc 和 GCC 12 的 libstdc++ |

不能仅凭架构相同就推断其他发行版或更旧系统也已经验证。当前运行包不支持 Alpine/musl 和原生 Windows。可以用 `uname -s`、`uname -m` 查看系统与架构。从同一个 Release 下载对应压缩包及 `SHA256SUMS`，不要选 GitHub 自动生成的源码快照。

macOS 在下载目录执行：

```bash
shasum -a 256 mcp-dev-runtime-1.1.0-darwin-arm64.tar.gz
```

Linux 执行：

```bash
sha256sum mcp-dev-runtime-1.1.0-linux-x64-gnu.tar.gz
```

将整段哈希与 `SHA256SUMS` 中对应文件名的值核对；文件名替换为实际架构。哈希用于核对一致性，本身不代表发布者身份。已安装 `gh` 的用户还可以执行 `gh attestation verify ARCHIVE --repo dolibali/mcp-dev-runtime`，查看独立的 GitHub 构建来源证明。

**本版明确跳过发布者代码签名和 Apple 公证。** 上游组件或临时签名不等于本项目发布者签名。macOS 可能要求明确允许下载的软件运行；允许前先核对源码、发行页和校验值。安装器不会关闭 Gatekeeper、修改系统安全设置或去掉隔离属性。流水线已预留以后接入签名的步骤。

## 安装

以 Apple Silicon 为例：

```bash
tar -xzf mcp-dev-runtime-1.1.0-darwin-arm64.tar.gz
cd mcp-dev-runtime-1.1.0-darwin-arm64
./install.sh
```

其他平台使用对应文件名和目录。如果解压工具丢失外层脚本的可执行位，可以执行 `bash install.sh`。安装器校验解压文件清单，将程序复制到用户的版本目录，只创建缺失的私人配置，再注册 `mcp-dev-runtime`；`mdr` 没有冲突时同时注册。已有其他 `mdr` 时只跳过短命令，不会执行或覆盖它。正式长命令冲突时拒绝覆盖，详见下方源码版共存说明。

安装器不会下载依赖、编译、使用 sudo、修改 Shell 启动文件、启动服务或复制旧凭据。提示配置 PATH 时，请按输出将命令目录加入自己的 Shell 配置。默认是：

```bash
export PATH="$HOME/.local/bin:$PATH"
mdr paths
mdr doctor --offline
```

短命令被跳过时，改用 `mcp-dev-runtime`。入口只为 MDR 使用内置 Node，不注册或替换系统的 `node`，也不会改变开发命令继承的 PATH。

## 配置与运行数据

`mdr paths` 只报告当前安装实际解析的路径，不展示尚未使用的未来目录。

| 数据 | macOS 默认位置 | Linux 默认位置 |
| --- | --- | --- |
| 配置和 `runtime.env` | `~/Library/Application Support/mcp-dev-runtime/` | `~/.config/mcp-dev-runtime/` |
| 状态和默认历史 | `~/Library/Application Support/mcp-dev-runtime/runtime/` | `~/.local/state/mcp-dev-runtime/` |
| 日志 | `~/Library/Logs/mcp-dev-runtime/` | `~/.local/state/mcp-dev-runtime/logs/` |
| 程序版本 | `~/Library/Application Support/mcp-dev-runtime/releases/` | `~/.local/share/mcp-dev-runtime/releases/` |

Linux 尊重绝对路径形式的 `XDG_CONFIG_HOME`、`XDG_STATE_HOME` 和 `XDG_DATA_HOME`，忽略相对值。`--prefix` 只更改程序版本目录，不更改用户配置位置；`--bin-dir` 指定命令目录。配置必须是当前用户所有、权限 `0600` 的普通文件；配置目录必须是当前用户所有、权限 `0700` 的目录。符号链接或不安全权限会被拒绝，而不是擅自修正；原有配置内容保留。

v1.0.1 及以后只生成一份非敏感 `config.json` 和相邻的私有 `runtime.env`，统一配置会通过 `runtime.env_file` 自动关联它。用纯文本编辑器填写真实 Tunnel ID 和运行密钥；不要把秘密值写进 JSON、聊天或命令参数。已经发布的 v1.0.0 仍保持当时的 split 配置。填写后执行：

```bash
mdr tunnel-setup
mdr start --bg
mdr status
mdr doctor
mdr smoke
```

这些只是本地就绪与工具发现检查，不代表已经完成 ChatGPT 往返调用。普通 `status` 是简洁摘要，`--verbose` 显示细节，`--json` 保留机器可读对象；`mdr config` 显示实际生效的非敏感配置，`mdr tools` 显示工具启用策略。统一配置使用 `runtime.logs_dir` / `runtime.state_dir`；旧 split 安装继续兼容旧字段。没有单独的 error.log。

## 升级、回退与源码版共存

切换版本前检查运行任务并执行 `mdr stop`。下载并校验新包，用**同一个 prefix 和 bin 目录**执行新包安装器。各版本存放在独立目录，完整性和配置检查后原子切换 `current` 符号链接。选中的服务仍活动或不可达、已有版本目录内容不一致、命令属于其他程序时会拒绝操作。安装器不会删除旧版本或覆盖配置。回退时先停止服务，再运行可信旧包的安装器；降级前检查发行说明中的历史格式兼容范围。

现有源码版命令不会自动改指向发行版，旧配置、凭据和 `.runtime` 也不会自动搬迁。需要共存时，用 `--no-global-command` 安装发行包并使用打印出的绝对命令路径，或指定另一个 `--bin-dir`。明确迁移时，先停止源码实例、按其说明仅卸载属于自己的命令入口，再安装发行版，并在编辑器中主动转移设置。不要让两个实例使用同一端口或历史目录。

不可修改的 v1.0.0 压缩包仍提供 `./install.sh --unregister`，它只移除命令入口。**v1.0.1 已加入完整的 `./uninstall.sh`。**脚本会先展示准备删除的实际 MDR 自有路径，只在明确输入 `y` 后继续；随后安全停止自己管理的实例，删除自己拥有的命令、全部已安装版本、配置/凭据、默认状态/历史、日志和缓存。安装时还会把稳定的 `uninstall.sh` 保存到用户配置目录，因此以后无需保留最初的下载解压目录。外来命令文件以及无法充分证明归属的外部自定义 state/log/history 路径都会保留，不会递归误删。

生命周期命令推荐使用 `mdr start [--background|--bg]`、`mdr stop`、`mdr restart [--background|--bg]` 和 `mdr status`；原有 `up/down` 继续作为兼容别名。`restart` 会先确认自己管理的旧实例已经安全停止，再启动新实例；控制器不可达时会 fail-closed，不会根据磁盘 PID 强制结束进程。停止或重启 MCP 也会结束它自己创建的活动命令，因此应先检查正在执行的任务。

本地客户端仍可用 `mdr serve --transport http` 或 `mdr serve --transport stdio`，无需 Tunnel。`serve` 保留调用方工作目录；启动额外实例时应显式配置 `--config` 并使用独立历史目录。源码开发和 npm 发布是另外的路径：npm 包仍保留 private，源码目录里的 `./install.sh` 仍是构建式安装器。

## v1.1.0 的可选本机 Skill

安装或升级不会自动启用 Skill。按[本机 Skill 指南](SKILLS.zh-CN.md)把 `discover_skills`、`read_skill` 合并进已有 `tools.allow`。确认活动任务允许中断后重启选中的安装，再刷新 MCP 应用工具；不需要原生 Skill 上传入口。网页版模型的自然触发效果需要单独验收。
