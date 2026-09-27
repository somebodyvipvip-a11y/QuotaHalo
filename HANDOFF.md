# QuotaHalo（额度光环）交接

## 当前状态

Windows 托盘第一版已经实现 Codex 5 小时和每周额度显示。用户确认的产品名是 QuotaHalo，中文名“额度光环”。前端参考 `quota-floating-widget-concept.png`，采用紧凑深色半透明浮层和青色强调色。Qoder、Trae、WorkBuddy 暂不在当前版本内。

本轮修复加入 Windows 原生体验和 App Server 会话复用：浏览器入口改用 `ShellExecuteW`（不启动 `cmd.exe`），浮层空白区域支持拖动，窗口用 `SetWindowRgn` 应用与 CSS 相同半径的原生圆角。Tauri 原生阴影及 CSS 外投影已关闭，透明客户区外不会留下白色背景。底部设置按钮提供紫雾、青蓝、靛蓝、墨绿、琥珀和灰阶六种低明度皮肤，皮肤名写入 WebView 本机存储；每种皮肤的主文字均为白色。设置与刷新按钮使用 Lucide SVG 图标。App Server 在 QuotaHalo 进程生命周期内复用，账号与额度读取串行执行，JSON-RPC 请求编号递增；`-32603` 或 stdio 断开会销毁当前子进程、重新初始化全新的 App Server 会话并完整重读一次。启动时立即读取，之后每 3 分钟读取。每个 JSON-RPC 步骤最多 15 秒，整次读取最多 50 秒；前端以 50.5 秒保险超时并在 `finally` 中清除旋转状态。Windows 子进程使用 `CREATE_NO_WINDOW`；若 `HOME` 或 `CODEX_HOME` 缺失，从 `USERPROFILE` 补足本地配置目录。

额度字段解析保留官方 camelCase 输入和前端 snake_case 输出。初始化后直接调用 `account/rateLimits/read`，不再调用会偶发挂起的 `account/read`；只选择 `rateLimitsByLimitId.codex`，缺失时回退到 `rateLimits`；窗口长度必须精确为 300 或 10,080 分钟。单次 RPC 最多等待 15 秒，超时、stdio 断开或 `-32603` 会销毁子进程并以递增短退避重新初始化最多三个会话，总读取最多 50 秒。服务仍无响应时显示明确错误，不推算额度。

## 主要文件

- `src-tauri/src/main.rs`：CLI 自动发现、App Server JSON-RPC、额度解析、托盘与窗口定位。
- `src/main.js`：状态渲染、本地时区格式化、剩余百分比与倒计时。
- `src/styles.css`、`src/index.html`：浮层样式与结构。
- `src-tauri/tauri.conf.json`：Tauri 窗口和发布配置。
- `scripts/probe-codex.mjs`：只读诊断；只输出账号模式和额度窗口数值，不输出原始响应或认证信息。
- `scripts/test-frontend-bootstrap.ps1`：防止发布前端重新引入无法解析的裸模块导入。
- `scripts/test-refresh-lifecycle.mjs`：覆盖成功、RPC 错误和超时后的加载状态收尾。

## 验证

在项目根目录运行：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
& .\scripts\test-frontend-bootstrap.ps1
node scripts/test-refresh-lifecycle.mjs
cargo test --manifest-path src-tauri/Cargo.toml live_logged_in_codex_returns_quota_windows_over_a_reused_session -- --ignored
```

最后一项需要本机已登录 Codex 与网络连接；测试仅断言窗口存在、百分比有效和重置时间在未来，不打印认证令牌或 App Server 原始响应。当前工作环境运行该集成测试时，App Server 未能在 15 秒总时限内返回有效结果；因此真实额度读取仍需在用户的 Codex 桌面环境确认。需要诊断服务侧字段时运行 `node scripts/probe-codex.mjs`，它只输出白名单额度字段及不含原文的进程错误分类。

## 构建与运行

```powershell
cargo build --release --manifest-path src-tauri/Cargo.toml
```

裸 EXE 为 `src-tauri/target/release/quota-halo.exe`，交付副本为 `dist/QuotaHalo-0.1.13.exe`。完整模式沿用 0.1.11 的所有额度信息，窗口高度为 300px；设置提供 60%–100% 的 Windows 原生窗口透明度，以及完整 / 极简两种模式选择。极简窗口为 390×180px，只显示 5 小时额度圆环、倒计时和本地重置时刻。安装包可用 `npm run build` 另行生成。运行时需要系统 WebView2 与本机已登录的 Codex CLI；应用自动查找 `%LOCALAPPDATA%/OpenAI/Codex/bin/*/codex.exe`，也支持 PATH 回退。

## 后续工作

新增服务时为每个产品建立独立的只读数据适配器，不复用 Codex 认证状态。保持“无真实数据就显示缺失状态”的规则。多显示器任务栏定位仍需在更多 Windows 配置下验证。
