# QuotaHalo · 额度光环

**在 Windows 桌面随时查看 Codex 额度与常用 AI 开发工具积分。** QuotaHalo 是一款托盘浮层应用：打开就能看剩余额度、重置倒计时，以及 WorkBuddy、TRAE、Qoder 的积分状态。

<p align="center">
  <img src="docs/images/quotahalo-main.png" width="330" alt="QuotaHalo 实际运行截图：Codex 额度环、每周进度与三个积分账户" />
</p>

<p align="center"><em>真实 Windows 运行截图；额度数字来自截图时的本机账户，仅作界面展示。</em></p>

## 功能

| 能力 | 说明 |
| --- | --- |
| Codex 额度 | 展示 5 小时与每周窗口的剩余比例、重置时间和倒计时。 |
| 多服务积分 | 分别读取 WorkBuddy、TRAE 和 Qoder；一个服务失败不会阻断其他服务。 |
| 托盘与极简模式 | 可收起到通知区，也可切换为只显示 Codex 5 小时额度的小浮层。 |
| 外观 | 紫晶、湛蓝、青绿、琥珀四套皮肤；窗口透明度可在 60%–100% 之间调整。 |
| 凭据管理 | Qoder PAT 与 TRAE Token 保存在 Windows 凭据管理器，设置页可删除。 |

## 下载与运行

1. 从 [Releases](https://github.com/somebodyvipvip-a11y/QuotaHalo/releases) 下载最新的 `QuotaHalo-<版本号>.exe`。
2. 将文件放到任意目录，双击运行。它是便携版，无需安装程序。
3. 在 Windows 通知区找到 QuotaHalo 图标。点击图标显示或隐藏浮层；托盘菜单可刷新、打开 ChatGPT 用量页面或退出。

**运行环境：**Windows、Microsoft Edge WebView2 Runtime。要显示 Codex 额度，还需在本机安装并登录 Codex CLI。程序会先查找 `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`，再尝试 `PATH` 中的 `codex`。其他服务按需连接；不连接时会显示等待配置或相应错误状态。

> Release 提供裸 EXE。首次运行时若 Windows 提示未知发布者，请先核对文件来源与 Release 页面；本项目未提供代码签名证书。

## 使用指南

### 查看与刷新

- 主卡片显示 Codex 5 小时额度，下面显示每周额度。百分比表示**剩余**比例，不是已使用比例。
- Codex 启动时读取，此后约每 3 分钟自动刷新；其他服务约每 5 分钟刷新。底栏刷新按钮会立即更新所有服务。
- 读取期间会保留上一次有效数值；请求失败或超时会显示状态，不会把未知额度当作 0。
- 顶部按钮可缩小为极简模式、隐藏窗口；极简模式只显示 Codex 5 小时额度。

### 连接积分服务

点击底栏齿轮进入设置。各服务的连接方式如下：

| 服务 | 准备工作 | 在 QuotaHalo 中的操作 |
| --- | --- | --- |
| Codex | 本机 Codex CLI 已登录 | 无需额外配置，自动读取本机 App Server。 |
| WorkBuddy | 本机 WorkBuddy 已登录 | 自动读取本机共享登录态，无需在 QuotaHalo 输入密码。 |
| Qoder | 准备中国区 `pt-` 开头的个人访问令牌（PAT） | 在设置页粘贴 PAT 并点击“连接”。 |
| TRAE | 准备 TRAE 网页账号或 Cloud-IDE-Token | 在设置页打开 TRAE 登录窗口，或手动输入 Token。 |

Qoder 和 TRAE 凭据重启后会恢复；要移除，在对应卡片点击“忘记此登录”。WorkBuddy、Qoder、TRAE 使用各自服务的接口获取数据，服务端接口变化可能影响读取。Qoder 与 TRAE 的真实账号适配仍需更多用户验证，遇到异常欢迎提交 [Issue](https://github.com/somebodyvipvip-a11y/QuotaHalo/issues)，请勿附带令牌或 Cookie。

### 外观与窗口

设置页可选择皮肤和透明度。浮层可通过空白区域拖动；关闭按钮只会收起到托盘，真正退出请使用托盘菜单。多显示器、不同 DPI 或任务栏位置下，浮层和通知区的距离可能略有差异。

## 隐私与安全

- Codex 额度由本机 `codex app-server` 提供。QuotaHalo 只处理额度百分比、窗口长度和重置时间，不保存或输出认证令牌、邮箱与原始响应。
- Qoder PAT、TRAE Token 和读取到的会话凭据存于 Windows 凭据管理器；TRAE 网页登录窗口也可能在 WebView2 用户数据中保留网站会话。界面输入框连接后会清空。积分数值来自服务实时请求。
- WorkBuddy 使用本机已有的共享登录态。请不要把 PAT、Token、Cookie、诊断日志中的敏感信息或凭据管理器内容提交到仓库或 Issue。
- 本项目与 OpenAI、WorkBuddy、TRAE、Qoder 没有官方关联；各服务商标归其所有者。

## 从源码开发

需要 Windows、Node.js、Rust 工具链和 Microsoft Edge WebView2 Runtime。在仓库根目录执行：

```powershell
npm ci
npm run dev
```

生成便携版 EXE：

```powershell
.\scripts\build-bare-exe.ps1
```

脚本使用 `Cargo.lock` 执行 release 构建，将可执行文件复制到 `dist/QuotaHalo-<版本号>.exe`，并启动该文件。如需 NSIS 安装包，可运行 `npm run build`。`dist/`、`node_modules/` 和 Rust 构建目录均未纳入源码仓库；下载预编译文件请使用 Releases。

## 测试

```powershell
& .\scripts\test-frontend-bootstrap.ps1
node .\scripts\test-refresh-lifecycle.mjs
cargo test --locked --manifest-path src-tauri\Cargo.toml
```

依赖真实 Codex CLI 或 WorkBuddy 登录态的集成测试默认忽略，需要在已登录的本机环境手动执行。

## 常见问题

| 现象 | 检查方法 |
| --- | --- |
| Codex 显示读取失败 | 确认 Codex CLI 已安装、已登录，并能从上述路径或 `PATH` 找到。点击刷新后再试。 |
| Qoder / TRAE 没有积分 | 在设置页检查连接状态、凭据是否失效；必要时忘记登录并重新连接。 |
| WorkBuddy 显示未登录 | 先在本机启动并登录 WorkBuddy，再刷新 QuotaHalo。 |
| 只看到通知区图标 | 点击图标显示浮层；若位于隐藏图标区，先展开通知区。 |

## 参与贡献

欢迎提交问题报告和 Pull Request。提交前请运行上面的测试，并说明 Windows 版本、复现步骤及实际结果；请先清理截图和日志中的个人信息。项目使用 [AGPL-3.0 许可证](LICENSE)。
