# Handoff：读取 Qoder 剩余积分并接入 QuotaHalo

状态：**调研文档，未改动任何代码**。2026-09-28 更新：更正「代码已存在」的现状、补全本机能否直读的全量验证、新增官网同源接口，并记录已选定的取数路线（自带 WebView2 登录）。
2026-09-28 复核：TRAE 的网页登录链路已实装，据此重写 §6.1——补齐 TRAE 真实机制拆解、三方对比表、兼容性限制与适配 Qoder 的改动清单（该节取代原先基于 POC 的推测性计划）。

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
- **手动粘贴 token**：已实现，**当前唯一可用路线**，细节见 §4.1。
- **自建 device-code 登录**：应用内可见 `/api/v1/deviceToken/poll`、`/api/v1/deviceToken/refresh`、`/api/v1/jobToken/exchange|refresh`、`/api/v1/me/jobToken`，思路与 Codex 同构（自己一份凭据），但 client_id、PKCE、auth base URL 无公开文档，需逆向且随版本变。A 不成立时再考虑。

### 4.1 PAT 从哪来（2026-09-28 核实）

`connect_qoder`（`main.rs:506-514`）拿 PAT 先调 `POST openapi.qoder.com.cn/api/v1/jobToken/exchange`（body `{"personal_token": "<PAT>"}`）换 `jt-` 开头短期令牌，再用它调接口 A。**所以 PAT 的权限范围必须覆盖额度读取**，否则会出现「换 token 成功、取用量 403」。

官方两处文档给出的入口名称不一致，实测两条路径都落到同一个 CN 站页面：

| 来源 | 名称 | 链接 |
| --- | --- | --- |
| docs.qoder.com（新文档站） | Account → Integrations | `https://qoder.com/account/integrations` |
| 阿里云帮助中心（Qoder CN 控制台） | 设置 → API 令牌 | `https://qoder.com.cn/account/integrations` |
| docs.qoder.com `qoderwake/automated-tasks` | 个人设置 → 服务集成 | 同上 |

实测证据：`https://qoder.com.cn/account/integrations` 未登录 302 → `https://qoder.com.cn/sso/login/aliyun?oauth_callback=https%3A%2F%2Fqoder.com.cn%2Faccount%2Fintegrations`，说明该路径在 CN 站真实存在且登录后原样回跳。PAT 前缀 `pt-`（阿里云帮助中心明确）。

创建流程（官方原文照录：「登录 Qoder → 打开 Account → Integrations → 选择有效期和所需权限并创建 PAT → 立即复制生成的值；页面关闭后无法再次查看」）。

**待验证**：有效期上限（第三方教程称「最多 1 年」，官方文档未写上限）、权限范围的可选值（官方只写「所需的权限」，未列举项名）。项目内 PAT 仅用于读本账号用量，创建时建议勾选全部可选范围，宁可先宽后收；若遇 403，把实际 scope 名补进本节。

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

### 6.1 复用 TRAE 登录窗口方案的可行性结论（2026-09-28 复核，取代原 POC 计划）

**结论：可复用的是「外壳」，不可复用的是「内容」。** 登录窗口、轮询、凭据落库、失败态这一整套骨架能直接搬；凭据提取的细节、取数接口和解析必须重写，且有一个真正的阻塞项。

#### 6.1.1 先纠正一个前提：TRAE 并不从页面里抓积分数值

准确定义是：**从登录后的页面里取出凭据，再由 Rust 用 `reqwest` 直接调私有接口取数。** 页面上的积分数字从头到尾没被读过（全仓检索 `innerText` / `textContent` / DOM 抓取，登录链路里零命中）。已核对的完整链路：

| 步骤 | 实现 | 位置 |
| --- | --- | --- |
| 1. 弹出独立登录窗口 | `WebviewWindowBuilder::new(&app, "trae-auth", WebviewUrl::External("https://www.trae.cn/dashboard#usage"))`，配独立 `data_directory` = `app_local_data_dir/trae-login-profile` | `main.rs:626-641` |
| 2. 登录态跨重启保留 | 由 WebView2 该 profile 自身持久化 | 同上 |
| 3. Rust 单向轮询页面 | 每 2 s、最多 180 次：`eval_with_callback` 在页面里执行 JS 读 `localStorage['Cloud-IDE-Token']`；`cookies_for_url` 读 `X-Cloudide-Session` | `main.rs:565-595`、`645-677` |
| 4. 「登录成功」= 真接口能取到数 | `persist_trae_login` 先用候选凭据实调 `user_current_entitlement_list`，仅 `status == "ready"` 才落库 | `main.rs:597-623` |
| 5. 持久化 | Windows 凭据管理器 `QuotaHalo/trae-token`、`QuotaHalo/trae-session` | `credential_store.rs` |
| 6. 取数 | `reqwest` POST 私有接口，支持 bearer / cloudide / jwt / cookie 四种头 | `external_credits.rs:258-321` |
| 7. 换号与清除 | `forget_trae` 删凭据 + `clear_all_browsing_data()` 清 profile | `main.rs:530-555` |

**这条链路最值得复用的地方**：远程页面从不回调 Rust（capability 只有 `windows: ["main"]`，也没有 `remote.urls`），页面只被 Rust 单向 `eval`。因此原 §6.1 里那个最大不确定点——「Tauri 2 会不会给远程页面注入 `__TAURI__`」——**已经被绕开**：不需要改 capability、不需要改 CSP、没有 CORS、没有远程 IPC 注入问题。Qoder 应当沿用这个形态。

#### 6.1.2 对比一：登录授权流程

| 维度 | TRAE | Qoder | 可复用 |
| --- | --- | --- | --- |
| 入口 URL | `https://www.trae.cn/dashboard#usage`（同站 SPA，hash 路由） | `https://qoder.com.cn/account/usage`（未登录 302 → `users/sign-in?oauth_callback=...`） | ✅ 换 URL 即可 |
| 登录体系 | TRAE 站内账号 | **阿里云体系**（个人／企业／阿里云登录／注册） | ⚠️ 结构不同 |
| 是否会新开窗口或弹窗 | 站内表单，无 | SSO 可能 `window.open` 弹窗或跳第三方域 | ❌ Tauri 默认拒绝新窗口 |
| 长／短凭据分层 | 长会话 Cookie + 短 JWT，可用 `GetUserToken` **静默续期** | 官网控制台只有 Cookie 会话，**无对应续期接口** | ❌ 续期层不能照搬 |
| 凭据载体 | 页面 `localStorage`（JS 可读）**＋** HttpOnly Cookie | 纯 Cookie 会话（无 Cookie 即 401） | ⚠️ 需换提取方式 |
| 「登录完成」信号 | localStorage token 与基线不同 | 无对应物 | ⚠️ 判定逻辑要重写 |

#### 6.1.3 对比二：页面结构与凭据提取

| 维度 | TRAE | Qoder | 可复用 |
| --- | --- | --- | --- |
| 提取手段 | `eval_with_callback` 注入 JS 读 localStorage | 不需要 eval，只用 `cookies_for_url("https://qoder.com.cn/")` | ✅ 代码反而更简单 |
| HttpOnly Cookie | `X-Cloudide-Session` 实测可取到（走 WebView2 CookieManager，不受 JS 可见性限制） | 未知，但机制同类，预期可取 | ⚠️ 待 POC 确认 Cookie 名 |
| 页面域 vs 取数域 | `www.trae.cn` ↔ `api.trae.com.cn`（跨站，靠请求头） | 同为 `qoder.com.cn`（**同源，最省事**） | ✅ 比 TRAE 更简单 |
| profile 隔离 | 独立 `trae-login-profile` | 需新增 `qoder-login-profile` | ✅ 照抄 |
| 是否需要读页面 DOM 数字 | 不需要 | 不需要（有 Cookie）→ 仅 Cookie 路线被否时才退化 | ✅ |

#### 6.1.4 对比三：积分展示与数据面

| 维度 | TRAE | Qoder | 可复用 |
| --- | --- | --- | --- |
| 取数接口 | `POST api.trae.com.cn/trae/api/v2/pay/user_current_entitlement_list` | 官网路线：`GET qoder.com.cn/api/v2/me/usages/big_model_credits` | ❌ 接口与解析都要新写 |
| 现有代码用的接口 | 同上（已实现） | `GET openapi.qoder.com.cn/sash/api/v2/me/usage`，**仅 Bearer 可用，WebView Cookie 帮不上忙** | ❌ 两条路并存，不能混用 |
| 响应字段 | `...quota.credits_limit` / `usage.credits_amount`；`-1` = 不限量 | 接口 A 已知（`displayMode`/`qoderUsage.userQuota{total,used}`）；**接口 B 字段名未知** | ❌ **头号阻塞项** |
| 错误体 | `code` / `message` | 官网域是 `errorCode` / `errorMessage`，与 openapi 域不同 | ⚠️ 需双分支 |
| 企业模式 | 无此概念 | `displayMode=enterprise` 无数值，只能缺失 + 跳转 | ⚠️ 已实现，保留 |
| 展示口径 | 只显示数值，无进度条 | 只显示数值，无进度条 | ✅ 前端零改动 |

#### 6.1.5 兼容性限制：必须认账的四条

1. **接口 B 响应字段名未知（唯一硬阻塞）**。前端包只看得到请求、看不到响应。「能取到 Cookie」≠「能解析出数值」。可以合理假设仍是 `{total, used}` 语义，但按项目纪律不能凭假设写解析——必须先抓一次真实 JSON 的字段名。
2. **阿里云 SSO 的弹窗风险**。`qoder.com.cn` 登录走阿里云账号体系，若 SSO 以 `window.open` 或跳第三方域完成，Tauri 默认拒绝新建窗口，登录会直接卡死。需要在 builder 上挂 `on_new_window`：允许同窗口内导航，或把第三方登录页交给系统浏览器并处理回跳。**这是 TRAE 完全没有的成本。**
3. **凭据白名单与体积**。`credential_store.rs:15` 的 service 白名单要加 `qoder-session`；`write` 有 2560 字节上限，多 Cookie 串可能偏紧，需实测或只保留必需的 1–2 个 Cookie。
4. **维护成本翻倍**。走 WebView 后 Qoder 会同时存在两条取数路径（PAT→openapi / Cookie→官网）。按项目「不与 Codex 共用认证状态、每服务独立适配器」的约定，两条必须各自独立；官网域接口无文档、无兼容承诺（当前前端包 `qbase/qoder/0.0.711`）。

#### 6.1.6 若确定适配，关键改动清单（按依赖顺序）

| # | 改动 | 位置 |
| --- | --- | --- |
| 0 | **前置（阻塞）**：抓一次 `GET /api/v2/me/usages/big_model_credits` 真实响应，**只记字段名**，补进本文 §5 | — |
| 1 | 抽出公共「登录窗口 + 轮询」助手，TRAE 与 Qoder 共用 | 由 `main.rs:626-679` 抽取 |
| 2 | 新增 `QODER_WEB_URL` 与 `parse_qoder_web(&Value)`，处理 `displayMode` / `errorCode` / `Unauthorized` 分支 | `external_credits.rs` |
| 3 | 新增 `fetch_qoder_cookie(cookie: &str)`：`GET` + `Cookie:` 头，401/403 判过期；**不动**现有 `fetch_qoder` | `external_credits.rs` |
| 4 | 新增 `open_qoder_login`：label `qoder-auth`、`data_directory` = `qoder-login-profile`、`on_new_window` 处理 | `main.rs`（照 `open_trae_login` 改写） |
| 5 | 「登录完成」判定改为「无效→有效」跃迁：先取基线，仅在新跃迁时落库关窗，避免旧会话一开窗就被关掉 | `main.rs:645-677` 逻辑改写 |
| 6 | `forget_qoder` 增加 `clear_all_browsing_data()`；凭据白名单加 `qoder-session` | `main.rs:517-521`、`credential_store.rs:15` |
| 7 | `refresh_qoder` 分发：先试 Cookie 会话 → 失败回落 PAT 内存令牌 → 再失败显示缺失 | `main.rs:428-460` |
| 8 | `connection_status.qoder` 改为「有 PAT 或有 Cookie 会话」 | `main.rs:491-503` |
| 9 | 前端加「打开 Qoder 登录窗口」按钮 + `qoder-auth-complete` 事件，复用 `#login-trae` 那套 | `src/index.html:96-99`、`src/main.js:332-335`、`371-374` |
| 10 | **不需要改动** | `capabilities/default.json`（不加 `remote`）、`tauri.conf.json` 的 CSP |

#### 6.1.7 推进顺序（与原「先做 POC」计划不同）

**先不要动 WebView。** 两条路线的同一个阻塞项是「没用真实账号核对过字段」，而 PAT 路线已写完、已有 fixture 单测，验证成本最低：

1. 用现有 PAT 通道跑一次真实取数 → 确认接口 A 字段、`displayMode`、个人池／加购池口径。**这一步 0 新代码。**
2. 只有用户明确不想维护 PAT 时，才抓接口 B 字段名，再按 6.1.6 实现。
3. 任何情况下都不解密 Qoder 本机 `auth*.dat`、不复用 `mcp-router.json` 的 apiKey。

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
