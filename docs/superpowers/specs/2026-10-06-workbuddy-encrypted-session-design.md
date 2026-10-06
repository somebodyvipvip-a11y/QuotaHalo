# WorkBuddy 加密登录态兼容修复

目标：恢复本机 WorkBuddy 的真实积分读取。

## 已实现范围

共享会话每次刷新重读。登出标记优先，文件缺失、空 Token 仍显示请登录；文件读取错误、JSON 无效、账号缺失分别提示。`$wbEncrypted: 1` Token 转入 WorkBuddy 自带运行时读取。其他非字符串 Token 显示登录信息无效。继续支持明文 Token 和现有个人、企业积分接口，不记录凭据，不改动 WorkBuddy。

测试使用虚构会话文件，覆盖两种加密对象的分流识别、明文、登出标记、损坏 JSON、未知 Token 对象和缺失文件。版本按补丁更新为 0.7.2，保持现有构建元数据同步。

## 自动读取调查结果及边界

本机 WorkBuddy 5.7.6.0。`app.asar/main/index.js` 的 `/workbuddy/probe` 只返回运行状态和版本；`main/contract.js` 定义 `auth:getAccountUsage`，`main/server.js` 使用内部 stdio RPC。现阶段未验证第三方能够连接的积分读取入口，不把内部通道作为已可用方案。官方 CLI 文档提供认证配置，但未证明其 API Key 可查询 WorkBuddy 积分。

## 0.7.2 实施结果

目标修正为真实获取积分。通过已安装 WorkBuddy 的 Node 运行模式调用其 native storage 及 bundle 自带凭据读取模块，恢复标准加密字段的 accessToken。动态发现正在运行的 WorkBuddy 路径，从当前 bundle 解析加密类及 envelope parser 的导出名；不硬编码版本、安装路径或密钥。仅用隐藏子进程的私有 stdout 管道把会话传给 Rust，继续使用原有个人/企业积分请求。每次刷新重读，10 秒超时及进程回收，登出标记优先。真实账号积分测试已通过。

新增 helper 回归验证导出名变化、成功读取、登出、读取失败时不泄露原始错误，以及正常读取后的密钥缓冲区清理。现阶段需 WorkBuddy 运行，标准字段加密已验证；未来模块布局变化或 asym-v1 需要进一步适配。
