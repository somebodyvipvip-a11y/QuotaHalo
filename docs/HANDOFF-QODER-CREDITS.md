# Handoff：读取 Qoder 剩余积分并接入 QuotaHalo

状态：**调研文档，未改动任何代码**。实现前先确认文末「需要用户回答的问题」。

调研环境：Windows，Qoder CN 桌面版 0.3.4（运行中）/ 0.4.1、0.4.3（待更新），本机账号已登录（`.qoder-cn/.qoder-app-status.json` 有 `logged_in: true`）。

---

## 1. 结论速览

| 项 | 结论 |
| --- | --- |
| 唯一给出「剩余积分」的接口 | `GET https://openapi.qoder.com.cn/sash/api/v2/me/usage` |
| 辅助接口（套餐名/到期） | `GET https://openapi.qoder.com.cn/api/v2/user/plan` |
| 认证方式 | `Authorization: Bearer <access token>`，无 token 返回 `401 {"code":"TOKEN_INVALID","message":"missing authorization token"}`（已实测） |
| 能否照搬 Codex 的做法（spawn 官方进程 + JSON-RPC） | **不能**。本机没有独立的 `qodercli.exe`，CLI 是桌面应用内嵌 runtime；且官方 CLI 只有交互式 `/usage` 面板，没有无头/JSON 输出 |
| 能否从本地明文文件读到积分 | **不能**。`.qoder-app-status.json` 只有登录态/邮箱/头像/版本；`.qoder-cn/ipc/` 为空；日志与 sqlite 中没有额度数值 |
| 真正的卡点 | **access token 从哪里来**（见第 4 节），接口本身已经确定 |

---

## 2. 主接口：`/sash/api/v2/me/usage`

证据来源（两条独立来源互相印证）：

1. 桌面应用内置代码（`D:\Program Files\Qoder\Qoder CN\.qoder-versions\0.4.1\resources\app.asar` → `/out/main/index.js`，偏移 ~4716712）：`readAccountUsage()` 构造 `new URL("/sash/api/v2/me/usage", openApiBaseUrl)`，诊断字段 `operation: "account.getQuotaUsage"`，请求头由统一函数生成（与 `getAccountPlan`、`credits-summary` 同一个 header builder），超时 `AbortSignal.timeout(15000)`，`redirect: "error"`，401/403 视为登录过期并刷新 token。
2. 官方文档 [查看用量与额度](https://docs.qoder.com/zh/cli/usage)：CLI `/usage` 面板字段为 `Plan` / `Plan Credits Used` / `Add-on Credits Used` / `Org Resource Package`，与该接口的 `userQuota` / `addOnQuota` / `orgResourcePackage` 一一对应。
3. 运行日志印证：`%APPDATA%\com.qodercn.app.stable\logs\*/main.log` 中多次出现 `{"operation":"account.getProfileMetric","source":"credits-summary","host":"openapi.qoder.com.cn",...,"status":200}`。

### 响应结构（按应用自带校验函数还原）

```jsonc
{
  "displayMode": "qoder" | "enterprise",

  // displayMode = "qoder" 时存在，且 enterpriseUsage 必须不存在
  "qoderUsage": {
    "userType": "string",              // 必填、非空
    "expiresAt": 0,                    // number
    "upgradeUrl": "https://...",       // string
    "userQuota":            { "total": n, "used": n, "percentage": 0..1, "unit": "credits" },
    "addOnQuota":           { /* 同上 */ },
    "orgResourcePackage":   { "cap"/"total": n, "used": n, "available": bool },
    "dedicatedResourcePackages": [ /* 数组，元素结构未验证 */ ]
  },

  // displayMode = "enterprise" 时存在，且 qoderUsage 必须不存在
  "enterpriseUsage": {
    "openMode": "externalBrowser" | "systemDeepLink",
    "detailUrl": "https://..."          // 企业模式下**没有数值**，只有跳转链接
  }
}
```

字段名同时接受 snake_case（校验函数写了 `t.user_quota ?? t.userQuota`、`t.add_on_quota ?? t.addOnQuota`、`t.org_resource_package ?? t.orgResourcePackage ?? t.shared_quota ?? t.sharedQuota`），实现时按 camelCase 处理即可。

### 数值语义（**必须照抄应用的算法，不要自创**）

- `remaining = max(0, total - used)`；接口**不直接返回 remaining**。
- `percentage`：若响应里给的是 `0..1` → 换算成 `percentage * 100`；若已是 `>1` 则视为百分比原值；缺省时按 `total > 0 ? used / total * 100 : 0` 计算。
- `unit` 缺省为 `"credits"`。
- `orgResourcePackage`：应用用 `cap ?? total` 作为分母，`remaining = max(0, cap - used)`，并保留 `available` 布尔值；`total` 校验允许缺失（`orgResourcePackage` 不强制要求 `total`），个人版一般是 `null`，前端要能显示「—」。
- `displayMode === "enterprise"` 时**没有任何数值**，必须走「无真实数据就显示缺失状态 + 打开 detailUrl」的既有规则，不可推算。
- `used`/`total` 为负数或非有限数时，应用的校验直接判定 `ACCOUNT_USAGE_INVALID`；实现时应把这种响应当作「数据缺失」而不是 0。

---

## 3. 其他相关接口（都不是「剩余积分」的正解，仅备选/补充）

| 接口 | 用途 | 结论 |
| --- | --- | --- |
| `GET /api/v2/user/plan`（同一 host） | `userType`、`planTierName`、`isPersonalVersion`、`isHighestTier`、`organization{roleName,isSuspended}` | 适合显示套餐名/企业身份；401/403 同样按登录过期处理。**不含积分余额** |
| `GET /api/v2/quota/usage?outerProviders=cmcc` | 名字最像但**不是额度**：只解析 `outerProviders[].purchaseLink` / `usageLogLink`（运营商合作方跳转链接） | 可用来做「充值/明细」按钮，不可用于数值 |
| `GET /sash/api/v1/ai-conversations/credits-summary` | `totalCredits`、`peakCredits`（历史消耗统计，日志里 `source: "credits-summary"`） | 已消耗，不是剩余 |
| `GET /sash/api/v1/ai-conversations/credits-heatmap` | 消耗热力图 `items[]` + `total` | 同上 |
| `GET /sash/api/v1/me/campaigns` | 活动权益 `benefit.kind = "CREDITS"`、`amount: 100`、`claimStatus` | 是「可领的赠送积分」，不是余额；低额度提醒可考虑顺带展示 |
| Teams OpenAPI（官方文档，组织维度） | `GET /v1/organizations/{org}/members/{member}/usage-events`、`.../usage-summary`、`.../resource-packages`（含 `remainingValue`）等，认证 `Authorization: Bearer <ORGANIZATION_API_KEY>` | **唯一有官方文档和正式 API Key 的路径**，但要求账号在企业组织内且组织已签发 API Key；个人版用不上 |
| CLI `/usage` 斜杠命令 | 交互式面板 | 无 `--json`/无头模式，外部程序无法解析 |
| 网页 `https://qoder.com.cn/account/usage?client=qoder&sourceType=IDE` | 应用内菜单「打开用量页面」用的就是这个（`websiteBaseUrl + /account/usage`） | 未登录 302；同 host 也暴露 `/api/v2/*` 且未带 token 返回 401 |

`base URL` 汇总：OpenAPI `https://openapi.qoder.com.cn`，官网 `https://qoder.com.cn`（两者都服务 `/api/v2/...` 路径）。区域由本机固定为 `region: cn` / `product: qodercn`，`scope=app` 时应用会追加 `?product=app`。

---

## 4. 待决问题：access token 从哪来

接口已定，唯一缺口是认证。可选路径按推荐顺序：

### A. 用 QuotaHalo 自己的 WebView2 会话（推荐，先做 POC）
Tauri 已经带 WebView2。在 QuotaHalo 的**独立持久化 WebView2 profile** 里打开 `https://qoder.com.cn`，让用户登录一次；随后在该页面上下文里发起同源 `fetch`，拿到 `/sash/api/v2/me/usage` 或官网用量接口对应的数据。
- 优点：不触碰 Qoder 的任何凭据存储；token 由 Qoder 网页自己签发和续期，QuotaHalo 只是「用户授权的浏览器里读用户自己的数据」。
- 需要验证：① 网页用量页实际调用的 BFF 路径与是否需要 CSRF 头；② `openapi.qoder.com.cn` 是否接受 cookie 会话（跨站，大概率不接受，必须在 qoder.com.cn 同源下调用）；③ WebView2 profile 与 Qoder 应用互不影响、登录态能长期保持。
- 失败边界：会话过期时必须显示「需要重新登录」状态，不静默重试刷屏。

### B. 用户手动粘贴 Bearer token 到设置里
最省事，先把渲染链路跑通；缺点是 token 有效期未知，过期后要重新粘。实现要求：只存内存或系统凭据管理器，**不写日志、不进配置明文、不打印**（沿用 README 里 Codex 的凭据纪律）。

### C. QuotaHalo 自己做 device-code 登录
应用内观察到的相关路径：`/api/v1/deviceToken/poll`、`/api/v1/deviceToken/refresh`、`/api/v1/jobToken/exchange`、`/api/v1/jobToken/refresh`、`/api/v1/me/jobToken`。
- 这是最干净的长期方案（和 Codex 的 app-server 思路同构：自己一份凭据）。
- 但目前**没有公开文档**给出 client_id、PKCE 参数、auth base URL 等，需要逆向；脆且随版本变。除非 A/B 都不成立，否则先不做。

### D. 明确排除的路径
**不要**尝试解密或读取 Qoder 的凭据存储（`%APPDATA%\com.qodercn.app.stable\auth.v1.dat`、`auth-profile-overlays.v1.dat`、`.qoder-cn\.auth\`、Windows 凭据管理器里的 Qoder 条目），也不要复用 `mcp-router.json` 里的本地 apiKey（那是本机 MCP 路由的密钥，与账号额度无关）。本次调研已确认这些文件不含明文额度，继续深挖只增加凭据泄露面。

---

## 5. 实现落点（确认后执行）

1. **新增独立适配器**，不与 Codex 共用认证状态（HANDOFF.md 既有约束）：
   - `src-tauri/src/qoder.rs`：`fetch_qoder_usage() -> QoderUsage`，`GET /sash/api/v2/me/usage`，15 s 超时，401/403 归类为「登录过期」，其余错误归类为「服务不可用」；只读请求最多重试 2 次、间隔 3 s（与 Codex 一致）。
   - 结构体：`display_mode`、可选 `qoder_usage{user_type, expires_at, upgrade_url, user_quota, add_on_quota, org_resource_package}`；`QuotaWindow{total, used, percentage, unit}`，`remaining` 在 Rust 侧按 `max(0, total - used)` 派生，输出给前端保持 snake_case。
   - `enterprise` 模式：数值字段全部 `null` + `detail_url`，前端渲染「企业计量，点击查看」。
2. **探针脚本** `scripts/probe-qoder.mjs`（对标 `scripts/probe-codex.mjs`）：只输出白名单额度字段，绝不 dump 原始响应或 token；token 从环境变量读取。
3. **前端** `src/main.js`：多一行 `Qoder`，按设计稿显示 `1,280 积分` 形式（**积分不带进度条**，进度条只给 Codex 百分比用，见 `docs/superpowers/specs/2026-09-27-multi-service-quota-floating-widget-design.md`）；低额度只把该数值改暖色。
4. **测试**：`cargo test` 加两段——① fixture 解析（camelCase / snake_case / percentage 0..1 与 >1 / `orgResourcePackage: null` / `displayMode: enterprise`）；② `#[ignore]` 的联机用例，仅断言 `display_mode` 合法且 `userQuota.total >= used`，不打印数值与凭据。

---

## 6. 需要用户回答的问题（实现前必须确认）

1. 你的 Qoder 账号是**个人版**还是**企业/Teams 成员**？（决定能否直接用文档化的 Teams OpenAPI + API Key，那是唯一官方稳定的路；`displayMode` 为 `enterprise` 时根本没有余额数值。）
2. 是否接受方案 A（在 QuotaHalo 里登录一次 Qoder 官网，用自带 WebView2 会话取数）？这是当前唯一不需要逆向凭据的路线。
3. 若 A 不成立，是否接受 B（手动粘贴 token，过期后手动更新）作为第一版？
4. 「剩余积分」的口径：`userQuota` 单独显示，还是 `userQuota + addOnQuota (+ orgResourcePackage)` 合并成一个总数？（Codex 那边是两条窗口，Qoder 这里也可能是 2~3 个池子。）
5. 单位显示：整数积分（`1,280 积分`）是否需要保留小数？应用侧的 `total/used` 是 `number`，可能出现小数。

---

## 7. 复现验证命令

```bash
# 未带 token 应返回 401 TOKEN_INVALID
curl -i --max-time 15 https://openapi.qoder.com.cn/sash/api/v2/me/usage
curl -i --max-time 15 https://openapi.qoder.com.cn/api/v2/user/plan

# 拿到 token 后（不要写进仓库/脚本，用一次性环境变量）
TOKEN=... curl -H "Authorization: Bearer $TOKEN" https://openapi.qoder.com.cn/sash/api/v2/me/usage
```

拿到真实响应后，把 JSON 的**字段名**（去掉数值）补进本文档第 2 节，然后才开始写解析代码。
