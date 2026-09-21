# Windows 原生安装与开发

Windows 原生支持从 **v1.2.0** 开始提供，不会改变此前已经发布的附件。
x64 和 ARM64 使用各自的原生 ZIP；ARM64 交叉编译成功不等于真机验收，
发布流程要求对应的 Windows ARM64 原生 Runner 通过后才允许发布该产物。

## 预编译版安装

运行包内置固定版本 Node、生产依赖、对应架构的 Sharp 图片模块、固定版本
Tunnel，以及 `mdr-windows-host.exe`。最终用户无需安装 Node、npm、Go、
Python、MSVC、Git Bash 或 WSL，也不要求管理员提升权限。Git、ripgrep
仍属于可选开发工具，`mdr doctor` 会报告是否可用。

核对发行页 SHA-256，解压对应架构的 ZIP，在 PowerShell 中运行：

```powershell
[Runtime.InteropServices.RuntimeInformation]::OSArchitecture
Get-FileHash .\mcp-dev-runtime-1.2.0-win32-x64.zip -Algorithm SHA256
```

将完整哈希与同一发行页 `SHA256SUMS` 中的对应值比较。ARM64 系统将文件名
中的 `win32-x64` 替换为 `win32-arm64`。确认一致后再解压安装：

```powershell
Expand-Archive -LiteralPath .\mcp-dev-runtime-1.2.0-win32-x64.zip -DestinationPath .\mdr-1.2.0
Set-Location .\mdr-1.2.0\mcp-dev-runtime-1.2.0-win32-x64
.\install.ps1
```

沿用组织允许的脚本执行策略。安装器不会自动修改 ExecutionPolicy、绕过策略、
关闭安全软件、修改防火墙、安装系统服务或请求提权。发布者签名暂时跳过。

安装器注册长命令，并在没有冲突时注册 `mdr.exe`。如果命令目录还未加入 Path，
按安装器显示的位置加入**用户级 Path**，然后重新打开终端；系统 Path 和 Shell
配置不会自动修改。在这之前可以直接使用完整路径：

```powershell
& "$env:LOCALAPPDATA\Programs\mcp-dev-runtime\bin\mdr.exe" paths
```

## 默认目录与配置

| 内容 | 默认位置 |
| --- | --- |
| `config.json`、私有 `runtime.env` | `%LOCALAPPDATA%\mcp-dev-runtime` |
| 状态、默认历史 | `%LOCALAPPDATA%\mcp-dev-runtime\state` |
| 诊断日志 | `%LOCALAPPDATA%\mcp-dev-runtime\logs` |
| 缓存 | `%LOCALAPPDATA%\mcp-dev-runtime\cache` |
| 分版本程序目录 | `%LOCALAPPDATA%\Programs\mcp-dev-runtime\releases` |
| 原生命令入口 | `%LOCALAPPDATA%\Programs\mcp-dev-runtime\bin` |

新建私有目录使用 Windows DACL，不把 `chmod 0600` 当作 Windows 权限保护。
已有权限不安全或穿过重解析点的私有路径会被拒绝，不会递归修改用户目录权限。
全局／项目 Skill 是用户共享资产，不属于卸载目标。

仍使用一份非敏感 `config.json` 加私有 `runtime.env`。MCP 默认 3001，Tunnel
健康检查默认 9098；将 `tunnel.enabled` 设为 `false` 可只运行本地 MCP。

```powershell
mdr config
mdr tools
mdr start --bg
mdr status
mdr doctor
mdr smoke
mdr restart --bg
mdr stop
```

停止或重启前检查活动任务。`up`、`down`、`--background` 继续兼容。
控制通道使用原生命名管道及实例令牌，不根据旧状态文件里的 PID 直接杀进程。

## 命令执行

优先使用已安装的 PowerShell 7，否则使用系统 Windows PowerShell 5.1，并向
模型说明所选 Shell。5.1 不支持 PowerShell 7 的 `&&`、`||`，不要直接发送
Bash 语法。可显式选择已安装的 Bash/Sh/Zsh；本版不将 `cmd.exe` 作为直接
Shell 后端，但可以从 PowerShell 调用 CMD 或批处理文件。

请求 UTF-8 输出，保留显式退出码及最后一个失败外部程序的真实退出码。
脚本主动处理并恢复前面的错误时，保留正常 Shell 语义，不强行判为失败。
少数旧程序自己使用 OEM 编码，仍需调用者配置；MDR 不猜测并重写输出编码。

普通命令使用管道，`tty=true` 使用 ConPTY，终端输出保留必要的 ANSI 序列。
每个任务先以暂停状态创建，加入独立 Job Object 后再恢复执行；绑定失败就不
启动任务。已结束任务不会留下脱离的子进程，长期服务应保留活动执行会话。

Windows 没有等价的 POSIX 信号：交互任务温和取消发送 Ctrl-C，强制取消终止
所属 Job；管道任务使用 Job 终止。不会虚构 Unix 信号结果。受管 MCP 使用私有
继承通道完成正常关闭，在退出前刷新历史记录。

控制通道独立于子进程输入写入：即使程序不读取 stdin、输入管道写满，也不会
阻塞强制终止或父进程断开后的清理。待写入输入有容量上限，超限明确报错，
不静默丢弃。启动／关闭等待使用单调计时，系统校时不会提前触发超时或延长
等待预算；状态与历史中的日期时间仍按正常系统时间记录。

## 升级、回退、卸载

先停止服务，再运行新 ZIP 中的 `install.ps1`。配置和旧版本保留，通过原子更新
`current.json` 选择版本，不依赖符号链接权限，也不覆盖运行中的 exe。
重新安装可信的旧 ZIP 即可重新选择该版本；同版本不同内容会被拒绝。

```powershell
& "$env:LOCALAPPDATA\mcp-dev-runtime\uninstall.ps1"
```

只有输入 `y` 或 `Y` 才卸载，回车、`n`、EOF 都取消。卸载使用临时复制的运行时，
避免 Windows 锁定当前 exe 导致无法删除。只删除 MDR 自有命令、程序和默认数据；
外部自定义状态／日志／历史目录、共享 Skill 和源码仓库保留。

## 源码开发与验证

源码开发需要 Node 24+、npm，以及能使用 `release-toolchain.lock.json` 固定
工具链的 Go；不会自动安装系统级编译工具。

```powershell
.\install.ps1 --local-only --no-global-command
npm run test:windows
npm run release:check
npm run release:bundle -- --allow-dirty
```

`--allow-dirty` 仅用于本地测试，产物不能发布。正式 Windows 包必须由对应架构
原生 Runner 从干净提交构建和验收。Windows 不加载／打包 POSIX 的 node-pty
执行后端，也不需要为它安装 MSVC；图片模块使用锁定的对应架构预编译依赖。

服务端、SDK、安装包检查与真实 ChatGPT 往返、非管理员用户、其他 Windows
版本的验证分别记录，不用交叉编译代替原生运行证明。详见[验证记录](VALIDATION.md)。
