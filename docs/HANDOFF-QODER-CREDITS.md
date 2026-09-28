# Handoff：读取 Qoder 剩余积分并接入 QuotaHalo

状态：**调研文档，未改动任何代码**。2026-09-28 更新：更正「代码已存在」的现状、补全本机能否直读的全量验证、新增官网同源接口，并记录已选定的取数路线（自带 WebView2 登录）。

调研环境：Windows，Qoder CN 桌面版 0.3.4（运行中）/ 0.4.1、0.4.3（待更新），本机账号已登录（`~/.qoder-cn/.qoder-app-status.json` 有 `logged_in: true`）。

---

## 0. 先更正一件事：Qoder 的读取链路**已经写好了**

不是「从零接入」，而是「有链路、缺凭据、缺真实响应验证」。当前实现：

| 位置 | 内容 |
| --- | --- |
| `src-tauri/src/external_credits.rs:9` | `QODER_URL = https://openapi.qoder.com.cn/sash/api/v2/me/usage` |
| `src-tauri/src/external_credits.rs:12-34` | `qoder_pool` / `parse_qoder`：读 `displayMode`、`qoderUsage`、`userQuota`、`addOnQuota`；`remaining = max(0, total - used)`；个人池 + 加油包池求和；`enterprise` 返回「企业额度请在官网查看」 |
| `src-tauri/src/external_credits.rs:90-107` | `fetch_qoder(token)`：`Authorization: Bearer`，15 s 超时，401/403 → 「登录凭证已过期」，重试 2 次、间隔 2 s |
| `src-tauri/src/main.rs:423`、`:648` | `refresh_qoder` command 已实现并注册 |
| `src/index.html:59-62`、`:93-94` | Qoder 行 + 「Qoder Access Token」密码输入框 |
| `src/main.js:46`、`:217-224`、`:299-302` | 凭证只存内存 `credentials.qoder`，点「应用」后清空输入框；无凭证时显示「请在设置中配置凭证」 |
| `src-tauri/src/external_credits.rs:143-149` | 已有 fixture 单测：`userQuota 1000/250 + addOnQuota 200/50 → 900`、负值拒绝、enterprise 拒绝 |

**所以真正的缺口只有两个**：① Bearer token 从哪来（现在是手动粘贴，且重启即丢）；② 从未用真实响应验证过字段名。第 4~6 节解决这两点。

---

## 1. 结论速览

| 项 | 结论 |
| --- | --- |
| 剩余积分接口（Bearer 版，客户端） | `GET https://openapi.qoder.com.cn/sash/api/v2/me/usage` —— 现有代码用的就是它 |
| 剩余积分接口（Cookie 版，官网） | `GET https://qoder.com.cn/api/v2/me/usages/big_model_credits` —— **选定路线要用这条**（第 5 节） |
| 能否照搬 Codex 做法（spawn 官方进程 + JSON-RPC） | **不能**。本机无独立 `qodercli.exe`（CLI 是应用内嵌 runtime），官方 CLI 只有交互式 `/usage` 面板，无 JSON/无头输出 |
| 能否直接读本机文件拿到积分 | **不能**，第 3 节有全量扫描证据 |
| 数值口径 | 积分是 `number`（可能带小数）；接口只给 `total`/`used`，`remaining` 自己算 |

---

## 2. 接口 A：`openapi.qoder.com.cn/sash/api/v2/me/usage`（客户端 Bearer 路径）

证据（三处独立来源互证）：

1. 桌面应用内置代码（`D:\Program Files\Qoder\Qoder CN\.qoder-versions\0.4.1\resources\app.asar` → `/out/main/index.js`，偏移 ~4716712）：`readAccountUsage()` 构造 `new URL("/sash/api/v2/me/usage", openApiBaseUrl)`，诊断字段 `operation: "account.getQuotaUsage"`，`AbortSignal.timeout(15000)`，`redirect: "error"`，401/403 视为登录过期。
2. 官方文档 [查看用量与额度](https://docs.qoder.com/zh/cli/usage)：CLI `/usage` 面板字段 `Plan` / `Plan Credits Used` / `Add-on Credits Used` / `Org Resource Package`，与 `userQuota` / `addOnQuota` / `orgResourcePackage` 一一对应。
3. 本机日志：`%APPDATA%\com.qodercn.app.stable\logs\*/main.log` 有 `{"operation":"account.getProfileMetric","source":"credits-summary","host":"openapi.qoder.com.cn",...,"status":200}`。

响应结构（按应用自带的校验函数还原，camelCase / snake_case 都接受）：

```jsonc
{
  "displayMode": "qoder" | "enterprise",
  "qoderUsage": {                      // displayMode=qoder 时必有，且 enterpriseUsage 不存在
    "userType": "string",              // 必填非空
    "expiresAt": 0,                    // number
    "upgradeUrl": "https://...",
    "userQuota":          { "total": n, "used": n, "percentage": 0..1, "unit": "credits" },
    "addOnQuota":         { /* 同上 */ },
    "orgResourcePackage": { "cap"/"total": n, "used": n, "available": bool },  // 个人版通常 null
    "dedicatedResourcePackages": [ /* 元素结构未验证 */ ]
  },
  "enterpriseUsage": {                 // displayMode=enterprise 时必有，此时 qoderUsage 不存在
    "openMode": "externalBrowser" | "systemDeepLink",
    "detailUrl": "https://..."          // 企业模式下**没有数值**，只有跳转链接
  }
}
```

数值语义（照抄应用算法，别自创）：`remaining = max(0, total - used)`；`percentage` 为 `0..1` 时 ×100，已 `>1` 时按原值，缺省时 `total > 0 ? used/total*100 : 0`；`unit` 缺省 `"credits"`；`orgResourcePackage` 用 `cap ?? total` 作分母；`total`/`used` 为负或非有限值时应用判 `ACCOUNT_USAGE_INVALID`，应显示「数据缺失」而不是 0；`displayMode=enterprise` 时**没有任何数值**，只能缺失状态 + 跳转。

配套接口（都不含余额，别再走弯路）：

| 接口 | 实际内容 |
| --- | --- |
| `GET /api/v2/user/plan` | `userType`、`planTierName`、`isPersonalVersion`、`isHighestTier`、`organization{roleName,isSuspended}`；适合显示套餐名 |
| `GET /api/v2/quota/usage?outerProviders=cmcc` | 名字最像但**不是额度**：应用只解析 `outerProviders[].purchaseLink` / `usageLogLink`（运营商合作方跳转链接） |
| `GET /sash/api/v1/ai-conversations/credits-summary` / `credits-heatmap` | `totalCredits`、`peakCredits`、`items[]` —— 历史**已消耗**，不是剩余 |
| `GET /sash/api/v1/me/campaigns` | `benefit.kind = "CREDITS"`、`amount: 100`、`claimStatus` —— 可领赠送积分 |
| Teams OpenAPI（官方文档，组织维度） | `/v1/organizations/{org}/members/{member}/usage-events`、`.../usage-summary`、`.../resource-packages`（含 `remainingValue`），认证 `Bearer <ORGANIZATION_API_KEY>`。**唯一有官方文档和正式 API Key 的路径**，但要求企业组织且已签发 Key |

未带 token 实测：`401 {"code":"TOKEN_INVALID","message":"missing authorization token"}`。
base URL：OpenAPI `https://openapi.qoder.com.cn`，官网 `https://qoder.com.cn`；本机 `region: cn`、`product: qodercn`，`scope=app` 时应用追加 `?product=app`。

---

## 3. 「能不能直接从本机读」——已全量扫描，答案是不能

| 本机位置 | 实读内容 | 有无额度数值 |
| --- | --- | --- |
| `~/.qoder-cn/.qoder-app-status.json` | `logged_in`、邮箱、头像、`version`、`product` | 无 |
| `com.qodercn.app.stable/main.sqlite`（35 MB） | `credits` 只出现在聊天正文文本；无 `userQuota`/`qoderUsage`/`displayMode`/`openapi.qoder` | 无 |
| `Local Storage/leveldb`、`Session Storage`、`Network` | 只命中 `openapi.qoder` 字符串；含轮转后新 `.ldb` 复扫仍无额度键 | 无 |
| `~/.qoder-cn/logs/**`（runs / sessions / qoder-context） | 全文检索 `quota|credits|积分` | 无 |
| `~/.qoder-cn/ipc/` | **空目录**，本机没有可对接的服务端口 | 无 |

原因：额度只活在一次 HTTPS 响应里，Qoder 不落盘。

对比 **WorkBuddy 为什么能本机直读**：`workbuddy_credits.rs:19-36` 读 `%LOCALAPPDATA%/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`，那是 WorkBuddy 自己写的**明文 JSON**（`/auth/accessToken`、`/account/uid`），并用 `.logout` 标记判断登录态。Qoder 没有对应物——它的登录态在 `%APPDATA%\com.qodercn.app.stable\auth.v1.dat`、`auth-profile-overlays.v1.dat` 这类加密存储里。

> **排除项**：不要尝试解密 Qoder 的凭据存储（`auth*.dat`、`.qoder-cn/.auth/`、Windows 凭据管理器中的 Qoder 条目），也不要复用 `~/.qoder-cn/mcp-router.json` 里的 apiKey（本机 MCP 路由密钥，与账号额度无关）。已确认这些文件不含明文额度，继续深挖只扩大凭据泄露面。

---

## 4. 已选定路线：QuotaHalo 自带 WebView2 登录

用户 2026-09-28 的选择：**A. 自带 WebView2 登录**（否决「解密本机 Qoder 凭据」；「手动粘贴 token」即 §0 的现有实现，保留为兜底）。

这条路线仍然算「本机直读」，但读的是**本应用自己的 WebView2 profile**，不碰 Qoder 的文件：用户在 QuotaHalo 内登录一次 qoder.com.cn，会话由应用持久化，之后同源取数。

**关键推论：这条路线不能用接口 A。** `openapi.qoder.com.cn` 只认 `Authorization: Bearer`，跨站且拿不到 token，浏览器会话帮不上忙；必须走官网同源（Cookie 会话）的接口 B。

其他候选（保留记录，暂不做）：
- **手动粘贴 token**：已实现，重启丢失、有效期未知，作为兜底。
- **自建 device-code 登录**：应用内可见 `/api/v1/deviceToken/poll`、`/api/v1/deviceToken/refresh`、`/api/v1/jobToken/exchange|refresh`、`/api/v1/me/jobToken`，思路与 Codex 同构（自己一份凭据），但 client_id、PKCE、auth base URL 无公开文档，需逆向且随版本变。A 不成立时再考虑。

---

## 5. 接口 B：官网控制台同源接口（Cookie 会话）

证据来自官网生产前端包 `https://g.alicdn.com/qbase/qoder/0.0.711/index.js`（2.18 MB，在浏览器 qoder.com.cn 页面内读取该公开静态资源提取）：

```js
{ url: "/api/v2/me/usages/big_model_credits", method: "GET" }               // 当前积分用量/余额
{ url: "/api/v1/me/usages/big_model_credits/histories", method: "GET", params }
{ url: "/api/v1/me/quotas/{quota_key}/histories", method: "GET" }            // quota_key 写死为 "big_model_credits"
{ url: "/api/v1/me/userplan", method: "GET" }                                // 套餐
{ url: "/api/v1/me/organization-shared-usages/{...}", method: "GET" }        // 组织共享池
```

实测确认：

- 基址就是官网自身 `https://qoder.com.cn`。未带 cookie：`/api/v2/me/usages/big_model_credits` → **401**；`/api/v1/me/userplan` → `{"errorCode":"Unauthorized","errorMessage":"User not authenticated","requestId":...}`。
  注意错误体结构与 openapi 域**不同**：这里是 `errorCode`/`errorMessage`，不是 `code`/`message`，`external_credits.rs` 现有错误处理不能直接照搬。
- 登录入口：`https://qoder.com.cn/account/usage` 未登录 302 到 `https://qoder.com.cn/users/sign-in?oauth_callback=https%3A%2F%2Fqoder.com.cn%2Faccount%2Fusage`，页面提供「个人登录 / 企业登录 / 使用阿里云登录 / 立即注册」——即 WebView 里要走**阿里云体系登录**，会话有效期需 POC 观察。

**必须实测的未知项**：`big_model_credits` 响应的**字段名**。前端包只看得到请求，看不到响应结构。落地前要由使用者抓一次真实 JSON（只记录字段名，不要把数值/cookie 提交进仓库），再据此写 fixture 单测。可以假设它沿用 `{total, used}` 语义，但**不能凭假设写解析**。

---

## 6. 落地步骤（下一步执行，按顺序）

### 6.1 POC：先证明「远程页面能把数据送回 Rust」

现状（`src-tauri/tauri.conf.json`、`capabilities/default.json`）：只有一个 `label: "main"` 窗口；`app.withGlobalTauri: true`；`security.csp = "default-src 'self'"`；capability `windows: ["main"]`、权限仅 `core:default` + `core:window:allow-start-dragging`。

1. 新增第二个窗口（如 `label: "qoder-auth"`）加载 `https://qoder.com.cn/account/usage`。
2. 要在**远程页面**里 `fetch` 并回传 Rust，必须给 capability 加 `remote: { urls: ["https://qoder.com.cn/*"] }` 并列入该 window label；先验证 Tauri 2 是否向远程 URL 注入 `window.__TAURI__`（`withGlobalTauri` 对远程页面的生效范围是这条路线最大的不确定点）。
3. POC 判定标准：Rust 侧收到一段 JSON，并只打印**字段名**。
4. 若 2 不成立，退化方案（按成本排序）：① 在该 WebView 里直接读渲染后的用量面板文本（DOM 文案，脆弱但无需 IPC）；② 用 WebView2 原生 `CookieManager` 导出会话（需 `windows` crate 的 WebView2 接口）再交给现有 `reqwest` 适配器。

### 6.2 代码改动面（POC 通过后）

1. **独立适配器**，与 Codex / WorkBuddy 不共享认证状态（`HANDOFF.md` 既有约束）：把 WebView 返回的 JSON 解析为 `services::CreditSnapshot`（`src-tauri/src/services.rs` 已有 `ready/unlimited/missing` 三态，直接复用）。
2. **保留** `refresh_qoder(token)` 粘贴通道作兜底：两条路产出同一 `CreditSnapshot`；`src/main.js:217-224` 的分发改为「先试 WebView 会话 → 失败回落内存 token → 再失败显示缺失文案」。
3. **会话过期**：命中 401 或 `errorCode: "Unauthorized"` 时统一文案「Qoder 登录已过期，请重新登录」，并停止本轮重试（不刷屏），托盘菜单给「打开 Qoder 登录/用量页」动作。
4. **企业模式**：`displayMode: "enterprise"`（或官网接口返回组织计量）时无数值，按既有规则显示缺失状态 + 跳转，不可推算。
5. **展示口径**：设计稿要求 Qoder 显示 `1,280 积分` 且**不带进度条**（进度条只给 Codex 百分比用），低额度只把数值改暖色——见 `docs/superpowers/specs/2026-09-27-multi-service-quota-floating-widget-design.md`。`src/index.html:59-62` 现有结构已符合。
6. **测试**：fixture 解析（真实字段名确认后补）、`displayMode` / `errorCode` 分支、`missing` 状态；`#[ignore]` 联机用例只断言 `status == "ready"` 且 `remaining >= 0`，**不打印数值与 cookie**。
7. **凭据纪律**（沿用 README 约定）：不打印、不落日志、不进 Git、不 dump 原始响应；WebView2 profile 目录不要打进 `dist/`。

---

## 7. 需要你确认的问题

1. 你的 Qoder 账号是**个人版**还是**企业/Teams 成员**？`displayMode=enterprise` 时接口根本没有余额数值。
2. 是否接受「在 QuotaHalo 里用阿里云账号登录一次 Qoder 官网」这个交互（会话可能几天后过期，需重新登录）？
3. 「剩余积分」口径：只算 `userQuota`，还是 `userQuota + addOnQuota`（现有代码是两池求和），要不要再并入组织共享池？
4. 数值显示：`total/used` 是浮点，可能出小数——取整还是保留一位？
5. 官网接口属控制台私有接口，无官方文档，字段可能随前端版本（当前 `qbase/qoder/0.0.711`）变化。是否接受该维护成本，还是坚持「接口 A + 手动粘贴 token」？

---

## 8. 验证命令

```bash
# 接口 A（Bearer）：不带 token 应 401 TOKEN_INVALID
curl -i --max-time 15 https://openapi.qoder.com.cn/sash/api/v2/me/usage
curl -i --max-time 15 https://openapi.qoder.com.cn/api/v2/user/plan

# 接口 B（Cookie）：不带 cookie 应 401 / Unauthorized
curl -i --max-time 15 https://qoder.com.cn/api/v2/me/usages/big_model_credits
curl -i --max-time 15 https://qoder.com.cn/api/v1/me/userplan

# 已登录 token 的一次性验证（不要把 token 写进仓库或脚本文件）
TOKEN=... curl -s -H "Authorization: Bearer $TOKEN" https://openapi.qoder.com.cn/sash/api/v2/me/usage
```

拿到真实响应后，只把**字段名**（去掉数值、去掉 cookie/token）补进第 2 或第 5 节，再开始写解析代码。
