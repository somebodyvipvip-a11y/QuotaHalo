# QuotaHalo（额度光环）

Windows 托盘小工具，汇总 Codex 的 5 小时／每周额度，以及 WorkBuddy、TRAE、Qoder 的剩余积分。

## 运行

直接运行便携版裸 EXE（文件名包含当前版本号）：

`dist/QuotaHalo-<version>.exe`

应用启动时显示浮层，托盘左键可打开或隐藏。完整模式按服务分别显示真实额度；某服务读取失败时只在该行显示原因，其他服务仍可更新。底部齿轮提供深色玻璃主题、透明度以及 Qoder／TRAE 账号连接。极简模式仍只显示 Codex 的 5 小时额度。浮层可从非按钮区域拖动，右键托盘菜单提供刷新、打开 ChatGPT 用量页面和退出操作。

WorkBuddy 会在每次刷新时读取其本机共享登录会话，个人账户使用官方客户端的积分汇总接口；无需在 QuotaHalo 输入密码。Qoder 可在官网 Account Integrations 创建中国区 PAT（`pt-` 开头），首次连接后保存到 Windows 凭据管理器，启动时自动换取短期令牌。TRAE 可在设置中打开独立的网页登录窗口，登录后自动保存 Token 与会话 Cookie，Token 失效时用会话静默续期；也可手动粘贴 Cloud-IDE-Token。设置里的「忘记登录」会删除保存的凭据。不要把 PAT、Token 或 Cookie 发送到聊天或提交进 Git。

Codex 每 3 分钟刷新，积分服务每 5 分钟刷新；底部刷新按钮会同时刷新全部服务。Qoder 主数值合计个人套餐和加购积分，组织共享资源包不计入；WorkBuddy 合计返回的个人积分池，企业不限量显示为「不限量」；TRAE 合计当前权益中可识别的积分余额。没有真实响应时显示「—」和具体状态，不推算积分。

开发模式在项目目录执行：

```powershell
npm run dev
```

重新生成裸 EXE：

```powershell
.\scripts\build-bare-exe.ps1
```

脚本会执行锁定依赖的 release 构建，并输出 `dist/QuotaHalo-<version>.exe`；不会生成安装器，也不会在构建时改写 `Cargo.lock`。若 PowerShell 的执行策略阻止运行，可使用：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-bare-exe.ps1
```

如需安装包，执行 `npm run build`。

## 数据读取方式

应用优先查找本机 `%LOCALAPPDATA%/OpenAI/Codex/bin/*/codex.exe`，否则使用 `PATH` 中的 `codex`。首次刷新启动 `codex app-server`（默认 stdio 传输）并完成初始化；该本地进程在 QuotaHalo 运行期间复用，避免每次刷新重新握手。Windows 下以无控制台模式启动；如果子进程缺少 `HOME` 或 `CODEX_HOME`，会从 Windows 用户配置目录补齐其本地 Codex 配置路径。按官方 JSON-RPC 顺序调用：

1. `initialize`，然后发送 `initialized` 通知。
2. `account/rateLimits/read`。

应用只在内存中解析 `usedPercent`、`windowDurationMins` 和 `resetsAt`。它优先使用 `rateLimitsByLimitId.codex`，回退到 `rateLimits`，从 `primary` 与 `secondary` 收集窗口，并且只显示窗口长度恰好为 300 分钟（5 小时）和 10,080 分钟（每周）的额度。剩余比例由 `100 - usedPercent` 计算；`resetsAt` 是秒级 Unix 时间戳，在界面中按 Windows 本地时区格式化。启动时立即读取一次，之后每 3 分钟刷新。为规避桌面 Codex 的账号详情调用偶发挂起，QuotaHalo 不再调用 `account/read`，而是在初始化后直接读取官方的 `account/rateLimits/read`。单个 JSON-RPC 请求最多等待 15 秒；超时、stdio 断开或 `-32603` 时，会销毁当前子进程，以递增短退避重新初始化最多三个全新会话后完整重读。总读取时限保持 50 秒。超过时限或服务仍拒绝时，旋转状态会停止并显示错误，不显示猜测值。

Codex 读取链路不会读取、复制、打印、保存认证令牌、邮箱或 App Server 原始响应。Qoder PAT 与 TRAE 登录凭据保存在 Windows 凭据管理器，请求时只在内存中使用，不记录原始响应；服务不可用、未登录或响应字段不完整时显示缺失状态。

官方协议参考：[Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)。

## 已知限制

- 需要已安装 Codex CLI，并已使用 ChatGPT 账号登录。会自动发现桌面版 Codex 的本机安装目录。
- `-32603` 是 Codex App Server 返回的内部错误；有限重试后若仍拒绝请求，QuotaHalo 会显示服务错误，无法替代修复服务本身。
- 需有 Microsoft Edge WebView2 Runtime。Windows 11 一般预装；部分 Windows 10 设备需要自行安装。
- WorkBuddy 个人账号已通过本机真实登录态联机验证；企业分支、Qoder 与 TRAE 目前只有解析测试，仍需使用对应账号核对实时返回字段和积分口径。
- Qoder、TRAE 的额度接口来自客户端／网站内部调用，可能随服务更新而变化。PAT 与 TRAE 内嵌登录链路尚需真实账号核对；TRAE 会话彻底失效后需重新登录。
- 浮层在主显示器的通知区附近显示；多显示器下 Windows 的任务栏位置与缩放组合可能使其距离托盘略有偏差。
