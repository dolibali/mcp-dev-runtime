# 故障处理

| 现象 | 检查与处理 |
| --- | --- |
| `posix_spawnp failed` 且仅 PTY 失败 | 执行 `node scripts/prepare-pty.mjs`，随后运行 PTY 单元测试；检查宿主架构和原生依赖 |
| 安装后缺少原生模块 | 使用目标机器原生 Node 执行 `npm ci`，不要复制其他架构的 node_modules |
| `EADDRINUSE` | 查询目标端口占用；只在原终端停止对应服务，或使用其他端口 |
| `START_FAILED` | 查看 shell、workdir 和可执行权限；不能把启动失败解释为退出码 0 |
| `STDIN_CLOSED` | 普通管道不接受输入；交互任务以 tty=true 启动 |
| `SESSION_BUSY` | 同一默认读取或输入未结束，等待完成后续查；不要反复并发消费 |
| `UNKNOWN_SESSION` | 检查服务实例与容量淘汰；默认不按时间过期。可用 scope=history 查询磁盘记录，不要盲目重跑命令 |
| `REQUEST_ID_CONFLICT` | 仅在完整参数相同时重用标识；新操作使用新标识 |
| `output_gap=true` | 旧输出超出保留窗口；不能据此拼接完整原日志 |
| `has_more=true` 且进程退出 | 继续用 write_stdin 读取剩余保留输出 |
| `running` 长时间不结束 | 检查 watch 模式、开发服务器或交互等待；必要时明确终止 |
| `PARTIAL_APPLY` | 查看 changes、created_directories 和 failed_path，检查实际磁盘状态后决定补偿 |
| `TARGET_EXISTS` | Add/Move 不覆盖已有目标；改用 Update 或明确选择新路径 |
| `FILE_CHANGED` | 文件在预计算后变化；重读并重新生成补丁 |
| 图片不是受支持格式 | 仅接受 PNG/JPEG/WebP；SVG、动画和超限图片按实际错误处理 |
| ChatGPT 仍显示 echo | Tunnel 仍指向 stub，或应用工具定义尚未刷新 |
| MCP 3001 正常但 Tunnel 9098 报错 | 两者是不同服务，分别检查 MCP 与 Tunnel 凭据、版本和启动日志 |
| SDK 提示 json 模式丢弃通知 | 本服务使用有界轮询，不依赖请求中途的进度通知；最终结果和后续查询仍有效 |
| node:test 提示递归执行并跳过测试 | 任务环境会移除 NODE_TEST_CONTEXT；不要将旧构建版本用于新测试 |

## 诊断命令

```bash
node --version
npm ls --depth=0
npm run build
npm run doctor -- config.json
npm run test:all
```

日志默认写入 stderr，不打印完整命令、源文件或密钥。调试级别记录工具名称和处理耗时。共享诊断信息时优先提供工具错误码、调用状态和版本，不需要 API Key、Cookie 或整个环境变量表。

## 非交互启动缺少 Tunnel 环境变量

启动脚本会在凭据缺失时自动加载现有 zsh 启动配置，仅继承变量，不打印值。若加载后仍缺少变量，应检查配置是否定义并导出 `CONTROL_PLANE_API_KEY` 和 `CONTROL_PLANE_TUNNEL_ID`，不要在日志中输出真实密钥。`npm run verify:deployed` 可对当前运行的 MCP 进行六工具调用验证；它不经过 ChatGPT 或 Tunnel，不能替代托管客户端验收。

## Unified launcher

- Port occupied: stop the previous manual instance in its own terminal; the launcher never kills it automatically.
- Tunnel version mismatch: inspect `versions`, select the pinned binary or run `tunnel-setup --build`. Matching only the upstream base version is insufficient.
- Missing credentials: use exported values, `--env-file runtime.env`, or explicitly opt into `--shell-env`. Never paste key values into issues.
- Stale/unreachable supervisor: inspect `.runtime/launcher.log` and the state record. `down` never signals an arbitrary saved PID.
- Long state-directory path: use a shorter `--state-dir` because POSIX local socket paths have size limits.
- Windows: use the matching v1.2.0+ native x64/ARM64 ZIP and [Windows guide](WINDOWS.md). PowerShell 5.1 does not accept Bash syntax or PowerShell 7's `&&`/`||`. Do not disable organization execution policies or security software to force startup; inspect the reported shell, permissions and package identity instead.
