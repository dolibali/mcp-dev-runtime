# 从零连接 ChatGPT 网页版：新手图文教程

[English](CHATGPT_SETUP.md) | **简体中文** · [返回 README](README.zh-CN.md)

**目标：**在 ChatGPT 网页对话中选中 `mcp-dev-runtime`，让它通过本机服务完成你授权的开发操作。这里创建的是自己的开发者应用，不是“探索 GPT → 创建 GPT → Actions”，也不是向公共插件商店投稿。

网页入口与官方资料核对日期：**2026-09-20**。不同账号可能显示 Plugins、Apps 或 Connectors。下文给出主入口和备用入口；权限未开放时，应联系管理员或官方支持，而不是尝试绕过限制。

本教程对应**项目 0.3.0 / 工具契约 3.1**。需要登录的账号页面请在自己的浏览器中操作；核对公开文档不代表已经查看了你账户当前的页面。每一步先确认完成标志，再进入下一步；尤其不要在本机两个服务尚未启动时扫描工具。

> **密钥安全：**不要把真实 API Key 发到聊天、截图、README 或 GitHub。配置在自己的终端和浏览器里完成。本项目会以启动服务的系统用户权限执行命令，没有额外沙箱；请先阅读[安全说明](../SECURITY.md)。

## 一眼看懂要做什么

[确认账号](#step-0) → [开启开发者模式](#step-1) → [安装本地项目](#step-2) → [创建 Tunnel 并复制 ID](#step-3) → [创建 API Key](#step-4) → [填写本地配置](#step-5) → [启动服务](#step-6) → [创建 ChatGPT 应用并选择 Tunnel](#step-7) → [首次调用](#step-8)。

| 用途 | 官方网页入口 |
| --- | --- |
| ChatGPT 网页版 | [chatgpt.com](https://chatgpt.com/) |
| 创建开发者应用 | [ChatGPT Plugins](https://chatgpt.com/plugins) |
| 旧版 Apps / Connectors 设置 | [ChatGPT Connectors](https://chatgpt.com/#settings/Connectors) |
| 创建运行时 API Key | [Platform → Organization → API keys](https://platform.openai.com/settings/organization/api-keys?utm_source=chatgpt.com) |
| 创建隧道、查询 Tunnel ID | [Platform → Organization → Tunnels](https://platform.openai.com/settings/organization/tunnels) |
| 查询 Organization ID | [Platform → Organization → General](https://platform.openai.com/settings/organization/general) |
| 管理隧道权限 | [Platform → Organization roles](https://platform.openai.com/settings/organization/people/roles) |

API keys 地址中的 `utm_source=chatgpt.com` 只是来源参数；[去掉该参数](https://platform.openai.com/settings/organization/api-keys)也能进入同一设置路径，它不是密钥内容。

### 四个容易混淆的值

| 名称 | 例子或形式 | 填到哪里 |
| --- | --- | --- |
| 应用名称 | `mcp-dev-runtime` | ChatGPT 创建应用窗口的 Name |
| Tunnel ID | `tunnel_` 后跟 32 位小写十六进制字符 | 本地 `CONTROL_PLANE_TUNNEL_ID`；ChatGPT 的 Tunnel 选择或 ID 输入框 |
| Runtime API Key | 创建密钥时显示的完整秘密字符串 | **仅在本机配置文件**中填写 `CONTROL_PLANE_API_KEY`；运行时由 Tunnel 客户端用于向 OpenAI 认证 |
| 本地 MCP 地址 | `http://127.0.0.1:3001/mcp` | 本机 Tunnel 转发到的服务地址，不是 Tunnel ID |

API Key 页面不会生成 Tunnel ID。组织 ID、工作区 ID、隧道名称和工具返回的 `session_id` 也不能替代它。

<a id="step-0"></a>
## 第 0 步：确认账号和目标工作区

先在浏览器登录 ChatGPT，确认要在个人工作区还是公司 / 学校工作区使用。在另一个标签页登录 OpenAI Platform，并选中有权访问的目标组织。首次配置建议用同一个有权访问这两边资源的账号，减少混用账号的可能。

**ChatGPT 开发者模式、Platform 组织权限、密钥权限是三回事。** 订阅、克隆源码或创建一个普通密钥，都不会自动补齐所有权限。

当前[开发者指南](https://developers.openai.com/api/docs/guides/developer-mode)与[帮助中心](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)在界面及账号范围的表述上不完全一致。本教程先用开发者指南的入口，再提供帮助中心的备用入口；最终以实际账号开放和工作区策略为准，不承诺某个套餐必然具备所有权限。

**本步完成标志：**知道自己要连接哪个 ChatGPT 工作区、哪个 Platform 组织，而不是在不同标签页里无意使用了不同账户。

<a id="step-1"></a>
## 第 1 步：在 ChatGPT 网页打开开发者模式

按当前[官方开发者指南](https://developers.openai.com/api/docs/guides/developer-mode)操作：

1. 打开 [ChatGPT](https://chatgpt.com/)，点击个人头像或账号菜单，进入 **Settings / 设置**。
2. 打开 **Security and login / 安全与登录**。
3. 找到 **Developer mode / 开发者模式**，阅读风险说明后开启。
4. 打开 [Plugins 页面](https://chatgpt.com/plugins)，确认可以通过页面的**加号**创建开发者应用。先确认入口即可，不必现在提交应用表单。

**如果你的界面没有上面的开关：**在 **Settings → Apps → Advanced Settings → Developer mode** 查找；旧界面可能将 Apps 称为 Connectors。帮助中心还给出了 **Workspace settings → Apps → Create** 的管理员入口。受管理工作区可能需要管理员先在 **Permissions & Roles → Connected Data** 授权；不要把“没有权限”误判为本机安装失败。详见[官方帮助](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)。

这不是浏览器的 F12 开发者工具，也不需要修改浏览器实验性设置。

**本步完成标志：**你的账号已启用开发者模式，并能找到自定义应用的创建入口。

<a id="step-2"></a>
## 第 2 步：安装预编译运行包

在需要让 ChatGPT 访问的那台电脑打开终端，按[预编译安装指南](BINARY_INSTALL.zh-CN.md)选择 v1.0.0 对应平台压缩包，对照 `SHA256SUMS` 校验后解压，执行包内 `./install.sh`。运行包内置 Node、原生依赖和固定 Tunnel，不必安装 Node/npm/Go/编译器。本版明确跳过发布者签名与 Apple 公证，请在运行下载软件前核对系统要求的许可。

以 Apple Silicon 为例，下载并完成校验后：

```bash
tar -xzf mcp-dev-runtime-1.0.0-darwin-arm64.tar.gz
cd mcp-dev-runtime-1.0.0-darwin-arm64
./install.sh
```

Linux 或 Intel Mac 使用对应文件名。安装器复制版本化程序目录，只创建缺失的用户配置，并注册 `mcp-dev-runtime`；`mdr` 无冲突时同时注册。不会启动服务或下载依赖。短命令被跳过时，下文所有 `mdr` 都替换为 `mcp-dev-runtime`。需要补充 PATH 时按提示操作：

```bash
export PATH="$HOME/.local/bin:$PATH"
mdr paths
mdr doctor --offline
```

`mdr paths` 显示实际配置、日志路径，不展示尚未使用的目录。新配置的默认工作目录是用户主目录；需要时把 `cwd` 改为已有的绝对工作路径。它是默认目录，不是文件访问白名单。保留回环监听，不要用 sudo 运行 MDR。

**本步完成标志：**安装完成且离线 doctor 通过；还没有建立真实 Tunnel 连接。现有源码 checkout 可继续按[源码流程](README.zh-CN.md#install)使用，不要在预编译包里执行 npm setup 或覆盖源码版拥有的命令。日志说明见 [README](README.zh-CN.md#logs)。

<a id="step-3"></a>
## 第 3 步：创建 Tunnel，找到真正的 Tunnel ID

### 3.1 打开正确页面

进入 [Platform → Organization → Tunnels](https://platform.openai.com/settings/organization/tunnels)，确认当前组织正确。已有自己可使用的隧道时，直接打开该记录，不必重复创建。

需要新建时，点击 **Create tunnel / 创建隧道**。参考图中的字段含义如下：

| 字段 | 怎样填写 |
| --- | --- |
| Name | 用于辨认这台电脑，例如 `my-mac-dev`；名称不是 Tunnel ID |
| Description | 简短说明用途，可按页面要求填写 |
| Organization IDs | 选择或填写真实的 Platform 组织 ID；不要照抄截图占位值 |
| Workspace IDs | 关联实际使用的 ChatGPT 工作区，尤其需要让它在该工作区的隧道列表中出现时 |

![官方参考图：创建隧道，组织和工作区是两个不同关联字段](images/openai/tunnel-create-modal.png)

*来源：OpenAI tunnel-client 官方仓库的[创建隧道参考图](https://github.com/openai/tunnel-client/blob/70bb5a7e1305596f0216d7b18d0b7765d58576d5/docs/images/tunnel-create-modal.png)。这是带占位数据的说明图，不是你账户的实拍页面。*

### 3.2 组织 ID 和工作区 ID 去哪里找？

Organization ID 可在 [Platform 组织 General](https://platform.openai.com/settings/organization/general)查看。对于提供管理设置的 ChatGPT 工作区，从头像菜单进入 **Workspace settings → General**，查找工作区标识；官方[工作区设置说明](https://help.openai.com/en/articles/8411955-managing-workspace-settings-in-chatgpt-enterprise)将工作区和组织标识列在 General 下。

字段已自动关联或提供选择器时，确认后选择即可。不知道工作区 ID、个人账号没有该管理入口或字段必须填写而无可选项时，先请管理员或 OpenAI 支持确认关联，不要用邮箱、聊天链接、Platform 项目 ID 代填。只关联 Platform 组织并不保证它会出现在目标 ChatGPT 工作区。

### 3.3 创建后复制 ID

点击 **Create** 后，回到 Tunnels 列表，在新记录的 **ID** 列或详情的 ID 字段复制**完整值**。页面只显示缩略值时用复制按钮或进入详情，不要手工抄带省略号的显示文本。

真实格式是 `tunnel_` 后跟 32 位小写十六进制字符。保存好这一个 ID；稍后本地配置和 ChatGPT 连接选择必须指向**同一个隧道**。ID 不是密码，但仍不应随意公开实际部署标识。

创建与管理需要 Tunnels **Read + Manage**；运行与选择需要 **Read + Use**。新建记录可能需要约 25–30 秒变为可用；角色权限传播可能更久，官方排障说明提示最长可等约 30 分钟。不要反复创建同名隧道来排查权限问题。[权限说明](https://github.com/openai/tunnel-client/blob/master/docs/permissions.md) · [官方排障](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#troubleshooting)

**本步完成标志：**已复制真实 Tunnel ID，并确认目标工作区关联和使用权限。

<a id="step-4"></a>
## 第 4 步：在 API keys 页面创建运行时密钥

打开这个页面：**[Platform → Organization → API keys](https://platform.openai.com/settings/organization/api-keys?utm_source=chatgpt.com)**。选择与目标隧道匹配的组织和有权使用该隧道的身份，不要误进旁边的 **Admin keys**。

1. 点击 **Create new secret key / 创建新的密钥**；按钮文字略有变化时，选择创建 API 密钥的操作。
2. 如有 Name，填写便于辨认的名字，例如 `mcp-dev-runtime-local`。如要求选择身份或项目，使用该组织中已经获准使用目标隧道的身份和上下文。
3. Permissions 选择 **Restricted / 受限**；按[隧道官方权限指南](https://github.com/openai/tunnel-client/blob/master/docs/permissions.md#creating-keys)，仅授予所需的 **Tunnels → Read + Use**。不要为了省事改用 All 或管理员密钥。
4. 点击创建，把生成的**完整密钥**复制到本机安全位置，下一步填进 `runtime.env`。列表里的掩码不是完整密钥；已经无法取回完整值时，新建替代密钥并撤销不再使用的旧密钥。

密钥的身份本身也必须有该隧道的 Read + Use 权限；只勾选密钥权限不能越过组织授权。找不到 Tunnels 权限项时，确认页面的组织层级与权限，再请管理员处理，不要用普通 Read Only 模式替代 Use。

![官方参考图：组织角色中的 Tunnels Read、Manage、Use 权限](images/openai/tunnel-permissions-role.png)

*此图展示的是**组织角色权限界面，不是 API Key 创建弹窗**。它帮助识别权限名称；运行时通常只需要 Read + Use，不需要照图勾选全部。图来自[官方权限文档](https://github.com/openai/tunnel-client/blob/master/docs/permissions.md)。一般密钥创建按钮说明见[官方 API key 管理帮助](https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform)；隧道具体权限以隧道指南为准。*

**本步完成标志：**手里有运行时 API Key，而不是 Admin Key、ChatGPT 密码、密钥名称或带省略号的预览值。

<a id="step-5"></a>
## 第 5 步：填写本机凭据文件

安装器已经创建私人 `runtime.env`，并配置 MDR 读取它。用 `mdr paths` 找到实际配置，再用纯文本编辑器打开旁边的 `runtime.env`。默认位置是 macOS `~/Library/Application Support/mcp-dev-runtime/runtime.env`、Linux `~/.config/mcp-dev-runtime/runtime.env`；绝对路径 XDG 覆盖项会生效。

macOS 默认路径可执行：

```bash
nano "$HOME/Library/Application Support/mcp-dev-runtime/runtime.env"
```

把下面两个值改为自己的真实凭据，一行一个：

```dotenv
CONTROL_PLANE_TUNNEL_ID=tunnel_00000000000000000000000000000000
CONTROL_PLANE_API_KEY=replace-with-your-own-runtime-key
```

这些示例**不是可用凭据**。不要加入中文引号、Markdown 反引号或换行。在 nano 用 **Control+O → Enter** 保存，再 **Control+X** 退出；不是 Command。不要截图、打印或将密钥发到聊天/Git，文件应保持私人权限 `0600`。密钥泄露应撤销并换新，不是仅从最新文本删除。参考[官方密钥安全说明](https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety)。

当前统一配置会设置 `runtime.env_file: "runtime.env"`，并相对配置目录解析。已导出的非空凭据环境变量仍优先。已有旧 split 安装继续沿用自己的 launcher/env 设置，不会自动迁移凭据。

**本步完成标志：**两个真实值已保存在本机，未发到聊天或仓库。

<a id="step-6"></a>
## 第 6 步：验证并启动本地服务

预编译包已内置固定版本 Tunnel。`tunnel-setup` 核对包内版本与哈希，不会创建 Platform 隧道、签发密钥、下载最新代码，也不需要 Go；源码构建是单独的流程。

```bash
mdr tunnel-setup
mdr up --background
mdr status
mdr doctor
mdr smoke
```

不要在相同端口另外启动 `mdr serve` 或 `npm start`；`up` 已负责 MCP 和 Tunnel。`doctor` 核对本地 MCP、工具发现和选中 Tunnel 的就绪状态，`smoke` 应显示 `LOCAL MCP SMOKE PASSED`。`status` 是简洁摘要，`status --verbose` 补充细节，`status --json` 显示完整状态；运行时间精确到秒。

默认仍是 MCP `127.0.0.1:3001` 和独立的 Tunnel 健康端口 `127.0.0.1:9098`。冲突时先检查任务并停止选中的实例，再修改 `mdr paths` 显示的实际配置；保留回环地址，使用互不相同的空闲端口。全局 `mdr smoke` 会跟随当前配置，本地端口变化不影响 Tunnel ID。详见[端口说明](DEPLOYMENT.md#ports)。

原始 curl 探测只作可选排障，不是额外必做步骤。发行版日志在程序目录外，查看 `mdr paths` 显示的实际 Logs 路径及[日志指南](README.zh-CN.md#logs)。`mdr down` 会停止选中的实例及其任务，不是只读检查；后台运行也不是系统开机自启，不能让睡眠电脑持续在线。

**本步完成标志：**本地服务和诊断就绪。保持电脑开机联网；下一步仍需通过 ChatGPT 实际调用来验证完整链路。

<a id="step-7"></a>
## 第 7 步：在 ChatGPT 创建应用，Connection 选 Tunnel

回到同一目标工作区，打开 [ChatGPT Plugins](https://chatgpt.com/plugins)，点击**页面加号**创建开发者应用。旧界面可从 Settings → Apps → Create，或管理员的 Workspace settings → Apps → Create 进入。此处不是聊天输入框旁的加号。

按下面填写：

| 字段 / 操作 | 本项目默认部署的选择 |
| --- | --- |
| Name | `mcp-dev-runtime`，方便在对话中选择 |
| Description | 例如“在我自己的电脑上执行开发命令、修改文件和读取日志” |
| Icon | 可选，首次连接可留空 |
| **Connection** | **Tunnel / 隧道**，不选 Server URL |
| Available tunnels / Tunnel ID | 选择第 3 步创建的隧道；提供输入框时可粘贴完整 ID，必须与 `runtime.env` 一致 |
| **Authentication** | 默认选 **No Authentication / 无认证**，指的是本项目的 MCP 服务认证层 |
| OAuth 高级设置、额外请求头 | 默认部署不需要填写 |
| Scan Tools | 等扫描完成，检查下方六个工具 |
| Create | 阅读风险提示、确认配置，再创建应用 |

**为什么这里选 No Authentication？** 本项目默认 MCP 监听在本机回环地址，并未实现 OAuth；Tunnel 自身仍用 Runtime API Key 向 OpenAI 认证。这是两层不同的认证。不要将 Runtime API Key 填进 OAuth Client Secret，也不要通过关闭已有的企业认证来照搬本教程。如果你另加了认证网关，以它实际需要的认证方式为准。

**不要在公网 Server URL 模式里填 `http://127.0.0.1:3001/mcp`。** 这条接入路径由本机 Tunnel 转发到该地址。No Authentication 只针对默认 MCP 层，不会关闭 OpenAI 对 Tunnel 的授权，也不表示本地服务可以直接暴露公网。MCP 认证选项见[官方开发者指南](https://developers.openai.com/api/docs/guides/developer-mode)。

**下面官方示例图显示 OAuth，仅用于展示 Tunnel 选择位置。你的默认配置应按上表选择 No Authentication，不要照抄图中的 OAuth。**

![官方参考图：ChatGPT 新应用窗口中的 Connection Tunnel 和隧道选择列表](images/openai/chatgpt-connector-tunnel-select.png)

*图片出处：[OpenAI 官方连接参考图](https://github.com/openai/tunnel-client/blob/70bb5a7e1305596f0216d7b18d0b7765d58576d5/docs/images/chatgpt-connector-tunnel-select.png)。图中旧名称、占位 ID、OAuth 选项不代表你账户的当前设置。*

扫描后应看到：`exec_command`、`write_stdin`、`apply_patch`、`view_image`、`list_exec_sessions`、`terminate_exec_session`。扫描过程中本机服务必须在线。如果表单自动发现工具而没有独立扫描按钮，核对发现结果后再保存。

新应用可能显示在 Drafts 或 Enabled Apps，并标记 Dev。组织内共享可能需要管理员审批；本教程只连接你自己的开发者应用，不要求发布到公共商店，也不要求上传仓库 ZIP、OpenAPI 文件或本地配置文件。[官方连接步骤](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#connect-from-chatgpt) · [官方应用配置说明](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)

**本步完成标志：**应用已创建，工具扫描成功，而不是只填完了名称。

<a id="step-8"></a>
## 第 8 步：在新对话里做第一次真实调用

新建普通 ChatGPT 对话，点击**输入框旁的加号**，在 Developer mode / 应用选择中选择 `mcp-dev-runtime`。界面支持时，也可输入 `@` 后从选择列表中点选应用；只打出名称不代表已启用它。

发送下面这句话，并在出现授权提示时核对命令：

> 只使用 mcp-dev-runtime 的 exec_command，执行 pwd 和 printf 'mcp-ready\n'，返回真实输出及退出码，不修改文件，不读取环境变量或任何密钥。

正确结果应有当前目录、`mcp-ready`，且命令最终 `exit_code` 为 `0`。展开工具调用详情确认是真实调用，不能只凭模型回答“已连接”判断成功。工具尚为 `running` 时应使用原 `session_id` 继续读取，而不是再启动相同命令。

测试成功后，再给出明确的项目目录和任务。需要隔天回看日志时，启动该任务时指定 `capture_output: true`；默认历史元数据不等于默认保存全部原始输出。更多例子见[历史与恢复](HISTORY_AND_RECOVERY.md)。

还可以发送下面的无害测试，验证刷新后的新参数：

> 使用 mcp-dev-runtime 执行 printf 'setup-line-1\nsetup-line-2\n'，设置 label 为 setup/first-check，capture_output 为 true。用 scope history 按该 label 查询，取得 session_id 和 archive_id，再读取 tail_lines 1，并搜索 line-2。不要修改源码或读取任何密钥。

预期历史记录没有截断，最后一行是 `setup-line-2`，搜索能返回匹配项。这次只明确记录生成的测试标记。缺少新参数时应刷新应用详情中的工具定义，不是重新创建 API Key。操作依据见 [OpenAI 连接、测试和刷新说明](https://developers.openai.com/plugins/deploy/connect-chatgpt)。

**本步完成标志：**ChatGPT 当前对话实际调用到了你的电脑，并显示了预期标记与退出码。

<a id="troubleshooting"></a>
## 卡住时按现象排查

| 现象 | 先检查什么 |
| --- | --- |
| `./install.sh: Permission denied` | 在确认可信的源码目录运行 `bash install.sh`，或用 `chmod +x install.sh` 恢复可执行位。部分 ZIP / 图形解压方式会丢失 Unix 文件权限。 |
| 找不到开发者模式 | 对照第 1 步两种入口；确认是网页、正确工作区及账号权限；联系管理员，不必反复重装 |
| 创建界面没有 Tunnel | 确认进入开发者 MCP 应用，不是自定义 GPT Actions；核对官方指南与工作区开放情况 |
| API keys 页面没有创建按钮或 Tunnels 权限 | 确认选中目标组织，使用组织 API keys 入口，并具有对应权限 |
| 平台能看到隧道，ChatGPT 列表里没有 | 核对目标工作区关联、Read + Use 和角色传播；仅关联组织可能不够 |
| Tunnel ID 格式错误 | 检查是否完整复制 `tunnel_` 加 32 位小写十六进制字符，不能包含省略号 |
| 401 / invalid API key | 密钥是否完整、未撤销、来自正确上下文；不要把 Admin Key、名称或掩码当运行时密钥 |
| 403 / Tunnels access required | 区分创建所需 Manage 与运行所需 Use；主体权限和密钥权限都要满足 |
| `No compatible Tunnel binary` | 按第 6 步准备依赖并构建固定源码；不跳过版本校验 |
| `address already in use` | 是否同时启动 `npm start` 与 `npm run up`；不要随意终止其他应用 |
| `fetch failed` 或连接超时 | 区分本地 MCP 健康失败和 Tunnel 出站网络、代理、TLS 失败，查看对应服务日志；不要靠关闭证书验证消除错误 |
| Scan Tools 失败 | MCP 与 Tunnel 是否都在运行；本机执行 `status`、`doctor`、`smoke`；确认 MCP 认证未误选 OAuth |
| 对话说无法用工具 | 确认本对话已选中应用，工具未禁用，权限提示已处理；以真实工具返回为准 |
| 新参数没出现 | 服务升级后重新加载，再在应用详情刷新工具定义，必要时新建对话；两个步骤不是一回事 |
| 改了 runtime.env 仍使用旧设置 | 非空终端环境变量优先；已运行服务不会热重载配置，确认无活动任务再重启 |
| 真实密钥已发进聊天、Git 或截图 | 撤销并替换密钥，更新私人配置，再验证新密钥；只删除可见文字不会使旧密钥失效 |

需要查看本机日志时运行 `tail -n 50 .runtime/mcp.log .runtime/tunnel.log`。日志、工作区 ID 和命令输出也可能涉及私人数据；公开求助前检查并脱敏，不要直接上传整个目录。更完整的故障说明见[排障文档](TROUBLESHOOTING.md)。

这些才是本项目的日志。运行 `desktop-commander remote` 的终端属于另一套应用，那里的错误不能直接当作本连接故障。网络回复丢失时，也不要仅因此重新执行结果未知、可能有副作用的命令。

## 下次使用、升级和停止

应用不需要每次重新创建。电脑重启后，在项目目录运行 `npm run up -- --env-file runtime.env --background`，检查就绪即可；本项目没有默认安装开机服务。停止前确认没有要保留的活动任务，再执行 `npm run down`，它会停止受管服务及其任务。

改代码或工具参数后的完整升级步骤见 [README 日常维护](README.zh-CN.md#operations)。在 ChatGPT 应用详情执行 Refresh / 刷新时应保持服务在线，核对 `label`、`capture_output`、`scope`、`archive_id`、`tail_lines`、`search` 等新参数，不必填写或公开密钥。

## 图片与官方参考

三张图片均来自 OpenAI 的公开 tunnel-client 文档，按上游固定提交原样复制到本仓库，保证普通克隆或源码包也能显示，不依赖初始化 Git 子模块。它们是参考图，不是对你账号界面的实测承诺；没有使用生成式图片冒充截图。来源和许可证见[图片说明](images/openai/README.md)。

官方文档：[开发者模式](https://developers.openai.com/api/docs/guides/developer-mode)、[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)、[应用配置与工作区权限](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)、[隧道权限与密钥](https://github.com/openai/tunnel-client/blob/master/docs/permissions.md)、[上游入门](https://github.com/openai/tunnel-client/blob/master/docs/onboarding.md)。页面需要登录时，请在自己的浏览器打开；本文不代表已代你登录、创建密钥或调整组织权限。
