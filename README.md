# QuotaHalo（额度光环）

Windows 托盘小工具，用于显示本机已登录 Codex 的 5 小时和每周额度重置时间。

## 运行

直接运行便携版裸 EXE：

`dist/QuotaHalo-0.1.12.exe`

应用启动时显示浮层，托盘左键可打开或隐藏。浮层可从非按钮区域拖动，使用 Windows 原生圆角裁剪；已关闭 Windows 原生窗口阴影，透明客户区外不会留下白色边框。底部齿轮可切换紫雾、青蓝、靛蓝、墨绿、琥珀和灰阶皮肤，设置 60%–100% 的窗口透明度，或切换极简悬浮窗。极简模式只显示 5 小时额度的圆形剩余比例、距重置倒计时和重置时刻；右上角按钮可回到完整窗口。外观选择只保存为本机 WebView 的偏好。设置与刷新使用 [Lucide](https://github.com/lucide-icons/lucide) SVG 图标。右键菜单提供刷新、打开 ChatGPT 用量页面和退出操作。打开用量页面直接调用系统默认浏览器，不经过控制台窗口。

开发模式在项目目录执行：

```powershell
npm run dev
```

重新生成裸 EXE：

```powershell
cargo build --release --manifest-path src-tauri/Cargo.toml
```

生成的可执行文件位于 `src-tauri/target/release/quota-halo.exe`。如需安装包，执行 `npm run build`。

## 数据读取方式

应用优先查找本机 `%LOCALAPPDATA%/OpenAI/Codex/bin/*/codex.exe`，否则使用 `PATH` 中的 `codex`。首次刷新启动 `codex app-server`（默认 stdio 传输）并完成初始化；该本地进程在 QuotaHalo 运行期间复用，避免每次刷新重新握手。Windows 下以无控制台模式启动；如果子进程缺少 `HOME` 或 `CODEX_HOME`，会从 Windows 用户配置目录补齐其本地 Codex 配置路径。按官方 JSON-RPC 顺序调用：

1. `initialize`，然后发送 `initialized` 通知。
2. `account/rateLimits/read`。

应用只在内存中解析 `usedPercent`、`windowDurationMins` 和 `resetsAt`。它优先使用 `rateLimitsByLimitId.codex`，回退到 `rateLimits`，从 `primary` 与 `secondary` 收集窗口，并且只显示窗口长度恰好为 300 分钟（5 小时）和 10,080 分钟（每周）的额度。剩余比例由 `100 - usedPercent` 计算；`resetsAt` 是秒级 Unix 时间戳，在界面中按 Windows 本地时区格式化。启动时立即读取一次，之后每 3 分钟刷新。为规避桌面 Codex 的账号详情调用偶发挂起，QuotaHalo 不再调用 `account/read`，而是在初始化后直接读取官方的 `account/rateLimits/read`。单个 JSON-RPC 请求最多等待 15 秒；超时、stdio 断开或 `-32603` 时，会销毁当前子进程，以递增短退避重新初始化最多三个全新会话后完整重读。总读取时限保持 50 秒。超过时限或服务仍拒绝时，旋转状态会停止并显示错误，不显示猜测值。

不会读取、复制、打印、保存认证令牌、邮箱或 App Server 原始响应。服务不可用、未登录、超时或未返回目标窗口时，界面不会猜测数值，而会展示对应状态和 ChatGPT 用量页入口。

官方协议参考：[Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)。

## 已知限制

- 需要已安装 Codex CLI，并已使用 ChatGPT 账号登录。会自动发现桌面版 Codex 的本机安装目录。
- `-32603` 是 Codex App Server 返回的内部错误；有限重试后若仍拒绝请求，QuotaHalo 会显示服务错误，无法替代修复服务本身。
- 需有 Microsoft Edge WebView2 Runtime。Windows 11 一般预装；部分 Windows 10 设备需要自行安装。
- 当前版本仅处理 Codex；Qoder、Trae 和 WorkBuddy 将作为独立数据源在后续版本加入。
- 浮层在主显示器的通知区附近显示；多显示器下 Windows 的任务栏位置与缩放组合可能使其距离托盘略有偏差。
