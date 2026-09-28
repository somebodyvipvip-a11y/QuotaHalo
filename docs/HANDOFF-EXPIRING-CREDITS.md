# Handoff：查询「最快过期的积分」（WorkBuddy / TRAE / Qoder 三账号）

状态：**调研文档，未改动任何代码**。
调研时间：2026-09-28。取证对象：本机三账号均已登录的 QuotaHalo 工作树（commit `b53421f`），并通过**只读探针**对三个服务的真实响应做了字段级取证（只记录字段名、类型与格式，不含任何数值、Token 与原始响应）。
前置：积分账户中的三个账号已登录 —— 存续方式见 §2。

---

## 0. 核查结论：应用内有没有「最快过期积分」入口？

**没有。** UI、命令、托盘、数据模型全链路都没有"到期时间"的位置：

| 层 | 位置 | 现状 |
| --- | --- | --- |
| 前端 UI | `src/index.html:62-79`（「积分账户」区） | 三个服务各一行：服务名 + 剩余数值 + 缺失说明；无到期信息、无入口按钮 |
| 前端渲染 | `src/main.js:189-203`（`renderCredit`） | 只渲染 `remaining` / `total` / `unlimited` / `message` |
| 设置面板 | `src/index.html:107-133` | 只有连接凭据、忘记登录、主题、透明度 |
| 托盘菜单 | `src-tauri/src/main.rs:845-849` | 仅「刷新额度」「打开 ChatGPT 用量页面」「退出」 |
| 命令注册 | `src-tauri/src/main.rs:906-921` | `refresh_workbuddy` / `refresh_qoder` / `refresh_trae` / `connection_status`；无过期相关命令 |
| 数据模型 | `src-tauri/src/services.rs:3-11` | `CreditSnapshot` 只有 status/remaining/total/unlimited/message/updated_at，**无到期字段** |
| WorkBuddy 解析 | `src-tauri/src/workbuddy_credits.rs:70-119` | 只取 `CycleRemainCapacity`/`CycleTotalCapacity`、`limitNum`/`credit`，其余字段全部丢弃 |
| TRAE 解析 | `src-tauri/src/external_credits.rs:92-130` | 只取 `credits_limit` / `usage.credits_amount`，`expire_time` 等字段被丢弃 |
| Qoder 解析 | `src-tauri/src/external_credits.rs:38-65` | 只取 `userQuota`/`addOnQuota` 的 `total`/`used`，**真实响应中的 `expiresAt` 从未读取** |

结论：需要新建入口与取数；三个账号的凭据链路已全部就绪，**不需要新的登录流程**。

---

## 1. 结论速览

| 项 | 结论 |
| --- | --- |
| 三个服务是否已能取到积分 | 是，现有链路全部 live 可用（本机三账号实测通过） |
| 现有"剩余总量"接口是否含到期信息 | WorkBuddy 汇总接口**不含**；明细接口**含**（已实测字段）；TRAE 现有接口**含** `expire_time`（已实测）；Qoder 只有 `expiresAt` 但**语义未确认** |
| 最快的可落地路径 | WorkBuddy → 明细接口 `ExpiredTime`；TRAE → `expire_time`；Qoder 暂缓（阻塞项见 §3.3） |
| 唯一阻塞项 | Qoder `expiresAt` 的语义与单位（15 位整数，不匹配任何常用 Unix 时间单位） |
| 口径决策点 | WorkBuddy 免费切片几乎总是"最快过期"（本机 27 条切片记录），需确认是否计入（§4.2） |

---

## 2. 三个账号的登录态与凭据位置（已就绪，可直接复用）

| 服务 | 登录态载体 | 读取方式（现有代码） | 备注 |
| --- | --- | --- | --- |
| WorkBuddy | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`（官方共享会话文件，明文 JSON） | `workbuddy_credits.rs:29-61` 每次刷新重读；`*.info.logged-out` 标记存在时视为未登录 | 无 QuotaHalo 侧存储；token 会被官方后台轮换，**不要缓存** |
| Qoder | Windows 凭据管理器 `QuotaHalo/qoder-pat`（PAT，`pt-` 开头） | `main.rs:506-514` 连接时保存；`refresh_qoder:428-460` 换取 `jt-` 短期令牌（内存缓存 20 小时） | 到期读取复用同一 PAT 换取的 `jt-` 令牌即可 |
| TRAE | Windows 凭据管理器 `QuotaHalo/trae-token` + `QuotaHalo/trae-session` | `main.rs:463-482` 优先用 token；失效时用 session 静默续期并回写 | 到期读取复用同一链路 |

补充：`connection_status`（`main.rs:491-503`）只覆盖 Qoder/TRAE；WorkBuddy 无连接状态命令，以积分行是否为 ready 判断。

---

## 3. 查询方法（按服务）

> 以下"已实测"字段均来自本轮只读探针（2026-09-28，本机登录账号，未记录任何值）。
> 认证头与现有的 `fetch_*` 实现完全一致，直接复用。

### 3.1 WorkBuddy：用「明细接口」取逐包到期时间

汇总接口 `POST /billing/meter/get-user-resource-summary`（现有实现所用）**已实测不含到期字段**，只有：
`Packages[].{PackageCode, CycleTotalCapacity, CycleRemainCapacity, CycleUsedCapacity, CycleFrozenCapacity, CapacityUnit, TotalCount}` + `SubscriptionPackageCode / IsPaidUser / IsProtectedPriceUser`。

到期信息在明细接口（个人账号）：

```
POST https://copilot.tencent.com/billing/meter/get-user-resource-paid-packages   ← 付费包
POST https://copilot.tencent.com/billing/meter/get-user-resource-free-packages   ← 免费/切片包
Content-Type: application/json
Authorization: Bearer <accessToken>
X-User-Id: <uid>
(企业账号再加 X-Enterprise-Id / X-Tenant-Id)

body（两接口同构，免费包额外带切片窗口）：
{
  "PageNumber": 1,
  "PageSize": 200,
  "PackageCodes": ["<summary 返回的 PackageCode 原样传入>"],
  "Status": [0, 3],
  "NeedRenewInfo": true,
  "SlicePeriodStartTime": "yyyy-MM-dd 00:00:00",   // 仅 free-packages
  "SlicePeriodEndTime":   "yyyy-MM-dd 23:59:59"    // 仅 free-packages
}
```

响应 `{ code, msg, requestId, data: { Accounts: [...], TotalCount } }`。`Accounts[]` 中与"余额 + 到期"相关的**已实测字段**：

| 用途 | 字段 | 实测类型/格式 |
| --- | --- | --- |
| 剩余量 | `CapacityRemain` / `CapacityRemainPrecise` | number |
| 周期剩余量 | `CycleCapacityRemain` / `CycleCapacityRemainPrecise` | number |
| 量单位 | `CapacityUnit` | string |
| **包到期时间（候选）** | `ExpiredTime` | 字符串 `yyyy-MM-dd HH:mm:ss`（19 位） |
| 周期终点（候选） | `CycleStartTime` / `CycleEndTime` | 字符串 `yyyy-MM-dd HH:mm:ss` |
| 扣减窗口（候选） | `DeductionStartTime` / `DeductionEndTime` | **epoch 毫秒（13 位整数）** |
| 标识/状态 | `PackageCode` / `PackageName` / `Status` / `CapacityType` / `PkgSourceType` / `RemainCycles` / `TotalCycles` | 混合 |

实测规模：本机账号 free 返回 **27 条**切片账户、paid 返回 **0 条**（该账号无付费包）；付费账号的 `Accounts[]` 结构预期一致但**未在本机验证**。

算法（建议）：
1. 取 paid + free 两路明细，合并 `Accounts[]`；
2. 过滤 `CapacityRemain > 0` 且到期时间在将来；
3. remaining = `CapacityRemain`，expires_at = 上表候选字段之一（**口径待定，见下**）。

**待确认（落地前必须做）**：
- `ExpiredTime` / `CycleEndTime` / `DeductionEndTime` 三者谁是"这批积分失效时刻"的权威口径 —— 对照 WorkBuddy 客户端的积分明细/到期展示核对一次即可。切片窗口（按日）语义上最接近 `DeductionEndTime`。
- 企业账号走 `/v2/billing/meter/get-enterprise-user-usage`，该接口只给 `cycleResetTime`（见 `HANDOFF-WORKBUDDY-CREDITS.md` §3.1），**无逐包明细**，企业口径需另行处理。

### 3.2 TRAE：现有接口已含 `expire_time`，解析即可

现有接口一次拿全（与 `external_credits.rs:258-321` 的 `fetch_trae` 完全同款）：

```
POST https://api.trae.com.cn/trae/api/v2/pay/user_current_entitlement_list
Authorization: Cloud-IDE-JWT <trae-token>
Cookie: X-Cloudide-Session=<trae-session>
X-User-Region: cn
body: {"require_usage":true,"full_data":true,"Request":{}}
```

`user_entitlement_pack_list[]` 中与"余额 + 到期"相关的**已实测字段**：

| 用途 | 字段 | 实测类型/格式 |
| --- | --- | --- |
| **包到期时间** | `expire_time` | number，10 位 → **秒级 Unix 时间戳** |
| 年包到期 | `yearly_expire_time` | number；本机 = 0（未使用） |
| 下一账期 | `next_billing_time` | number；本机 = 0（未使用） |
| 权益起止 | `entitlement_base_info.start_time` / `end_time` | number，10 位（秒级），与 `expire_time` 同域 |
| 积分上限 | `entitlement_base_info.quota.credits_limit` | number；订阅权限包无此字段（应跳过） |
| 已用 | `usage.credits_amount` | number；未使用过的包不返回 |
| 过滤参考 | `status`、`is_last_period`、`is_oneweek`、`is_hide`、`source_id` | 混合（`is_oneweek`/`is_last_period` 为 bool；语义待核对） |

实测规模：本机返回 **26 个包**；包[0] 无 `credits_limit`（订阅权限包），包[1]、[2] 同时有 `credits_limit` 与 `credits_amount`。

算法（与官网前端口径一致，见 `trae-credits-api-handoff.md` §3）：
1. 对每个包：跳过无 `credits_limit` 的订阅包；`used = usage.credits_amount ?? 0`；
2. `remaining = max(0, credits_limit - used)`，只保留 `remaining > 0` 且 `expire_time > now` 的包；
3. 最快过期 = `min(expire_time)`。

### 3.3 Qoder：`expiresAt` 存在但语义未确认（阻塞项）

现有接口（PAT → `jt-` 令牌，链路见 §2）：

```
GET https://openapi.qoder.com.cn/sash/api/v2/me/usage
Authorization: Bearer <jt-...>
```

`qoderUsage` 的**已实测字段**：

| 用途 | 字段 | 实测 |
| --- | --- | --- |
| 套餐池 | `userQuota.{total, used, remaining, percentage, unit}` | 齐全（注意：真实响应里额外存在 `remaining`） |
| 加购池 | `addOnQuota.{total, used, remaining, percentage, unit, detailUrl}` | 齐全；`detailUrl` 指向加购明细页，可核查到期信息 |
| **到期时间** | `expiresAt` | Int64，**15 位**；不匹配秒/毫秒/微秒/纳秒纪元换算，也非 `yyyyMMdd...` 打包日期；被 1000 整除 |
| 其他 | `displayMode / userId / userType / usageType / totalUsagePercentage / isQuotaExceeded / isPlanQuotaProrated / upgradeUrl` | — |

实测本机响应中**没有** `orgResourcePackage`、`dedicatedResourcePackages`（`HANDOFF-QODER-CREDITS.md` 样例里有，真实账号未出现）。

**阻塞项**：`expiresAt` 的单位与"它到底指哪个池的到期"无法从字段形态推断。落地前必须二选一验证：
1. 对照 Qoder 官网「用量」页展示的到期日期，反推单位与含义；
2. 反查 Qoder 桌面版 `app.asar` 中 `expiresAt` 的格式化/使用逻辑。

在确认前，Qoder 的到期数据**不应实现**，显示"到期信息待确认"即可（不推算，符合项目既有纪律）。
备选线索：官网 Cookie 路线接口 B `GET https://qoder.com.cn/api/v2/me/usages/big_model_credits`（字段名仍未取证，见 `HANDOFF-QODER-CREDITS.md` §5）。

---

## 4. 统一「最快过期」算法与口径决策点

### 4.1 归一化

| 服务 | 原始格式 | 归一化为 |
| --- | --- | --- |
| WorkBuddy | `ExpiredTime` 字符串 `yyyy-MM-dd HH:mm:ss`（中国区口径） | 按 `+08:00` 解析为秒级 Unix；`DeductionEndTime` 已是毫秒 → `/1000` |
| TRAE | 秒级 Unix | 直接用 |
| Qoder | 未知（15 位整数） | 待确认前不接入 |

聚合：收集三服务 `{ service, label, remaining, expires_at }` → 过滤 `remaining > 0` 与有效 `expires_at` → 取 `min(expires_at)`。
展示建议：`最快过期：TRAE 120 积分 · 09/29 23:59`（沿用 `src/main.js` 的 `formatTime` 本机时区格式）。
规则沿用现有纪律：读不到就显示缺失/待确认，**不推算**；任一服务失败只影响其自身。

### 4.2 口径决策点（实现前需用户确认）

1. **WorkBuddy 免费切片是否计入**：本机 27 条切片多为按日窗口，若计入，"最快过期"将永远落在 WorkBuddy 今天的切片上。建议：默认只统计付费包/周期包，免费切片单独展示或忽略；或按 `CapacityType`/`PackageCode` 分类后决定。
2. **TRAE 多来源积分**：26 个包中是否全部逐包比较（含赠送/奖励），还是只算当前周期包（`is_last_period` 语义待核对）。
3. **Qoder 到期**：是否愿意先做 WorkBuddy + TRAE 两服务、Qoder 标注"待确认"。
4. **展示粒度**：只显示全局最早一条，还是每服务各显示其最早一条（推荐后者，信息更稳）。

---

## 5. 实现落点（后续执行，本轮未改代码）

1. **数据模型**：`src-tauri/src/services.rs` 新增 `ExpiringCredit { service, label?, remaining, expires_at }`（独立结构，避免污染 `CreditSnapshot` 三态语义）。
2. **适配器**（不与 Codex 共用认证状态，沿用项目约定）：
   - `workbuddy_credits.rs`：新增明细解析（paid + free，复用 `read_session`）；
   - `external_credits.rs`：TRAE 在 `parse_trae` 基础上扩出逐包 `expire_time` 收集；Qoder 不动（阻塞）。
3. **命令**：`main.rs` 新增 `refresh_expiring_credit`（聚合三服务；沿用现有 15 秒超时与退避策略）。
4. **前端**：`src/index.html` 积分账户区底部加一行；`src/main.js` 增加渲染并入 `refreshCredits`（5 分钟节奏）。
5. **凭据**：无需新增类型，`credential_store.rs:15` 白名单不动。
6. **测试**：fixture 解析（到期字段正常/缺失/为 0/负值）+ `#[ignore]` 联机用例只断言结构存在，不打印数值。

---

## 6. 只读探针（本轮已实际执行，可复现）

纪律：**只打印字段名 / 类型 / 格式判定，绝不打印数值、Token、Cookie 或原始响应**。

- WorkBuddy（零依赖，读共享会话文件直连）：

```powershell
$p = Join-Path $env:LOCALAPPDATA 'CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info'
$s = Get-Content $p -Raw | ConvertFrom-Json
$h = @{ Authorization = "Bearer $($s.auth.accessToken)"; 'X-User-Id' = $s.account.uid; 'Accept-Language' = 'zh' }
$r = Invoke-RestMethod -Method Post -Headers $h -ContentType 'application/json' `
  -Uri 'https://copilot.tencent.com/billing/meter/get-user-resource-summary' -Body '{}'
# 再用 data.Packages[].PackageCode 调 paid/free-packages 明细，只列 Accounts[] 的键名
```

- Qoder / TRAE（凭据在 Windows 凭据管理器）：用 `CredReadW` P/Invoke 读取 `QuotaHalo/qoder-pat`、`QuotaHalo/trae-token`、`QuotaHalo/trae-session`（UTF-8 解码 blob），随后按 §3.3 / §3.2 的请求发一次，输出键名树。本轮即用此方式完成取证。
- 时间字段格式判定：对候选字段只打印"类型 + 数字位数 / 日期样式 / 是否可整除"等布尔判定，用于确定单位。

---

## 7. 风险与凭据纪律

- TRAE / Qoder 均为私有接口，无兼容承诺；字段缺失按缺失态处理，不猜测。
- 频率与风控：明细接口会新增请求数（WorkBuddy 官方有 5 秒 TTL + 单飞；TRAE 有风控），并入现有 5 分钟刷新，不新增高频轮询。
- WorkBuddy 亚毫秒级字段（`*Precise`）优先用于计算，展示取整沿用现有规则。
- 凭据只存内存使用；不打印、不落日志、不进 Git。

---

## 8. 下一步（按顺序）

1. 确认 §4.2 的四个口径决策点。
2. （可选，零代码）用 §3.1 的候选字段对照 WorkBuddy 客户端到期展示，定口径；用官网用量页对照 Qoder `expiresAt` 语义。
3. 实现 WorkBuddy + TRAE 的逐包到期解析（§5 第 1-3 步）。
4. 前端入口 + 展示（§5 第 4 步）。
5. Qoder 待语义确认后再接入。