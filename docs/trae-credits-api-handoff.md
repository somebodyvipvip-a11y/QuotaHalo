# TRAE 剩余积分读取 Handoff

本文档记录「在 QuotaHalo 中显示 TRAE 剩余积分」所需的接口调研结果与实现路径。调研已完成，**未修改任何代码**。

调研对象：本机 TRAE CN 客户端 `TRAE SOLO CN`（安装于 `D:\Program Files\TRAE SOLO CN`）与官网 `trae.cn` 前端。

---

## 1. 结论速览

| 项目 | 结论 |
| --- | --- |
| 数据来源 | TRAE CN 商业化服务（内部代号 `gtm-service`）的私有 Web API，与客户端、官网共用 |
| API 基址 | `https://api.trae.com.cn`（备选 `https://api.trae.cn`，两者实测行为一致） |
| 核心接口 | `POST /trae/api/v2/pay/user_current_entitlement_list` |
| 认证 | 必须携带登录凭证；未登录实测返回 **401** |
| 剩余积分算法 | `Σ(credits_limit) − Σ(usage.credits_amount)`，`-1` 表示不限量 |
| 请求方式 | `POST` + JSON body，body 形如 `{"require_usage":true,"full_data":true,"Request":{}}` |

> 这些是**未公开的私有接口**（官网/客户端内部调用），没有官方文档，字段与路径可能随版本变化。

---

## 2. 已确认的接口清单

以下路径均从 `trae.cn` 官网生产环境 JS 中提取（`/trae/api/...` 前缀），基址为 `https://api.trae.com.cn`。

### 2.1 首选：一次拿到权益 + 用量

```
POST /trae/api/v2/pay/user_current_entitlement_list
```

- 对应前端方法：`GetUserCurrentEntitlementListV2`
- 请求体：`{ "require_usage": true, "req_source": <可选>, "full_data": true, "Request": {} }`
- 说明：`require_usage: true` 时同时返回用量，**理论上一次调用即可算出剩余积分**，是最省事的入口。

### 2.2 拆分调用（备选）

| 接口 | 方法 | 用途 |
| --- | --- | --- |
| `/trae/api/v1/pay/ide_user_ent_usage` | POST | IDE 客户端用量（含 `usage.credits_amount`） |
| `/trae/api/v1/pay/web_user_ent_usage` | POST | Web 端用量 |
| `/trae/api/v1/pay/ide_user_pay_status` | POST | IDE 套餐/支付状态（body 可带 `trae_client`、`device_id`、`version_code`） |
| `/trae/api/v1/pay/web_user_pay_status` | POST | Web 套餐状态 |
| `/trae/api/v1/pay/user_cur_ent_base` | POST | 当前权益基础信息 |
| `/trae/api/v1/pay/user_current_entitlement_list` | POST | 权益列表旧版（v1） |
| `/trae/api/v2/pay/expired_ents` | POST | 已过期权益 |
| `/trae/api/v2/pay/cn_credits_billing_status` | POST | 是否已切换到积分计费模式（`is_credits_billing`、`should_force_switch`） |
| `/trae/api/v1/pay/billing_history` | POST | 账单历史 |
| `/trae/api/v1/pay/query_user_usage_group_by_session` | POST | 按会话维度用量明细（`start_time` 等参数） |

### 2.3 其他相关（官网商用接口，非积分）

`/api/v1/commercial/get_session_usage`、`/api/v1/commercial/get_user_activity`、`/api/v1/commercial/clear_user_activity`。

---

## 3. 剩余积分的计算逻辑

从官网前端 JS 提取到的原始逻辑（`credits_limit` 来自权益/套餐，`credits_amount` 来自用量）：

```js
// 对套餐型商品求和：剩余 = credits_limit - usage.credits_amount
const l = Number(product?.credits_limit ?? 0);
return l === -1 ? -1 : Math.round(Math.max(l - Number(product?.usage?.credits_amount ?? 0), 0));
```

由此可得：

- 剩余积分 = `credits_limit` − `usage.credits_amount`（可跨多个权益条目求和）
- `credits_limit === -1` 表示不限量，界面上对应「无限」文案（`cashier.credits.unlimited`）
- 套餐档位参考：Lite 2000 / Pro 4000 / Pro+ 12000 / Ultra 40000 积分每月（来自 `docs.trae.cn` 计费说明）

---

## 4. 认证（关键难点）

### 4.1 现状

- 直接 `POST https://api.trae.com.cn/trae/api/v1/pay/user_current_entitlement_list` → **401**（说明路径与域名正确，仅缺登录凭证）。
- 前端 JS 中出现的认证相关头部：`Authorization`、`X-Cloudide-Token`、`x-tt-passport-csrf-token`、`X-XSRF-TOKEN`。
- 前端通过 `gtmService` 实例注入 `jwt`，再配合 `getRequestHandler` 组装请求头。

> **待确认**：真实请求到底用 Cookie、`Authorization: Bearer`，还是 `X-Cloudide-Token`。建议用浏览器 DevTools 在 `trae.cn` 用量管理页抓一次真实请求，即可最终确定（见 4.3）。

### 4.2 本地已发现的凭证/状态痕迹

| 位置 | 内容 | 说明 |
| --- | --- | --- |
| `%APPDATA%\TRAE SOLO CN\Network\Cookies` | Chromium Cookie 数据库 | 加密（DPAPI），解密成本高 |
| `%APPDATA%\TRAE SOLO CN\Local Storage\leveldb` | 键 `trae-cn-credits-billing-status:v1:<userId>` | 仅缓存 `is_credits_billing` / `should_force_switch`，**不含积分数值** |
| `%APPDATA%\TRAE SOLO CN\logs\aha_log\aha_electron_*.log` | AHA 网络库日志 | 仅基础设施请求（`/service/settings/v3`、`device_register` 等），**不含积分请求** |

结论：积分数值不落盘，必须实时调用 API；登录凭证存在加密 Cookie 中。

### 4.3 获取凭证的三种方案

**方案 A：浏览器登录 trae.cn（推荐，改动最小）**

1. 用户在浏览器登录 `https://www.trae.cn`。
2. DevTools → Network → 打开「用量管理」，找到 `user_current_entitlement_list` 请求，复制其 Cookie / Authorization 头。
3. QuotaHalo 使用该凭证调用 API。

优点：无需解密、无需逆向加密。
缺点：凭证会过期，需要用户重新登录（可做「凭证失效 → 提示重新登录」）。

**方案 B：读取 TRAE 客户端加密 Cookie**

从 `%APPDATA%\TRAE SOLO CN\Network\Cookies` 读取，用 Windows DPAPI（`CryptUnprotectData`，密钥在 `Local State` 中）解密。

优点：完全自动，复用客户端登录态。
缺点：实现复杂、跨 Chromium 版本不稳定，且属于读取用户凭证的敏感操作。

**方案 C：内嵌 WebView 登录一次**

在 Tauri 内嵌 `https://www.trae.cn` 让用户登录一次，程序持久化会话后自行调用 API。

优点：体验可控、可自动刷新。
缺点：需要引入 WebView 登录流程与凭证存储。

> 建议先用 **方案 A** 打通数据链路，验证字段无误后，再考虑是否升级到 B/C。

---

## 5. 集成到 QuotaHalo 的步骤

现有架构参考 [HANDOFF.md](../HANDOFF.md) 与 [main.rs](../src-tauri/src/main.rs)：Codex 的读取逻辑集中在 `src-tauri/src/main.rs`，通过 `codex app-server` 的 JSON-RPC 获取额度，前端 [main.js](../src/main.js) 负责渲染。

建议按现有的「每产品独立只读适配器」约定（见 HANDOFF.md「后续工作」）实现：

1. **新增 TRAE 适配器**：在 Rust 侧新增独立模块/函数，负责
   - 读取凭证（方案 A 可先做成「用户粘贴/配置文件」形式）
   - `POST https://api.trae.com.cn/trae/api/v2/pay/user_current_entitlement_list`
   - 解析 `credits_limit` / `usage.credits_amount`，计算剩余积分
2. **数据结构对齐**：输出与现有 Codex 额度同构的 `{ remaining, limit, unlimited, fetchedAt }`（`-1` 映射为「不限量」）。
3. **前端展示**：在 [main.js](../src/main.js) 的渲染逻辑中为 TRAE 增加一个卡片/条目，沿用现有「无真实数据就显示缺失状态」的规则，不要猜测数值。
4. **刷新策略**：`cn_credits_billing_status` 前端缓存 `staleTime` 为 60 秒，可作为刷新间隔参考；建议沿用现有刷新节奏并做失败重试。

---

## 6. 验证方法

打通凭证前，可先用命令行确认：

```powershell
# 需替换为真实凭证头
Invoke-WebRequest -Uri 'https://api.trae.com.cn/trae/api/v2/pay/user_current_entitlement_list' `
  -Method POST -ContentType 'application/json' `
  -Headers @{ Authorization = 'Bearer <token>' } `
  -Body '{"require_usage":true,"full_data":true,"Request":{}}'
```

预期：`200` 且返回含 `credits_limit`、`usage.credits_amount` 的 JSON。
若仍为 `401`，说明凭证方式不对（换 Cookie 或 `X-Cloudide-Token` 头再试）。

> 注意：不要请求 `https://www.trae.cn/...`（会被前端风控返回 HTML 挑战页），一律走 `https://api.trae.com.cn`。

---

## 7. 风险与注意事项

- **私有接口**：无官方文档与兼容承诺，路径/字段可能被调整；建议把「字段缺失」当作正常分支处理，界面显示缺失而非 0。
- **频率与风控**：官网接口带风控（JS 挑战）。避免高频轮询，失败时退避重试。
- **凭证安全**：遵循项目现有约定——不打印、不落盘、不记录原始响应与凭证；只在内存中使用。
- **账号维度**：TRAE IDE / Work / 移动端共用同一账号积分（官方论坛确认），因此一个接口即可覆盖全部端。
- **需要登录态**：未登录只能用 `-1`/缺失状态展示，并给出「去官网用量管理」入口（对应 `https://www.trae.cn` 头像 → 用量管理）。

---

## 8. 待确认项（实现前建议逐一验证）

1. 真实请求的认证方式与头部名称（4.3 方案 A 抓包即可确定）。
2. `user_current_entitlement_list` 响应中 `credits_limit` / `usage.credits_amount` 的确切字段路径（可能嵌套在数组内），以及 `-1` 的实际表示。
3. `Request` 字段是否必填、是否需 `req_source` 参数。
4. 积分有效期与多来源（会员积分 / 奖励积分）是否需要分别展示——当前需求只需「剩余总量」。