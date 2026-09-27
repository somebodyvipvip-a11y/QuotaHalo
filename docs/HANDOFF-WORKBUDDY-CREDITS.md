# Handoff：读取 WorkBuddy 剩余积分并接入 QuotaHalo

状态：**调研文档，未改动任何代码**。实现前先确认文末「需要用户回答的问题」。

调研环境：Windows，WorkBuddy 桌面版 5.5.6（`deploymentType: SaaS`，`productName: WorkBuddy`），本机账号已登录。
取证来源：本机应用代码 `D:\Program Files\WorkBuddy\resources\app.asar`（内嵌 `packages/workbuddy-server`、`packages/agent-provider`、`packages/agent-ui`、`packages/core`）、产品配置 `~/.workbuddy/cache/acc-product-config-v3.json`、运行日志 `~/.workbuddy/logs/`、本地 SQLite `~/.workbuddy/workbuddy.db`。

---

## 1. 结论速览

| 项 | 结论 |
| --- | --- |
| 唯一给出「剩余积分」的接口 | `POST https://copilot.tencent.com/billing/meter/get-user-resource-summary` |
| 企业账号的用量接口 | `POST https://copilot.tencent.com/v2/billing/meter/get-enterprise-user-usage` |
| 剩余积分算法 | `Σ max(0, Packages[].CycleRemainCapacity)`（企业版：`limitNum - credit`） |
| 认证方式 | `Authorization: Bearer <accessToken>` + `X-User-Id: <uid>`；企业账号还需 `X-Enterprise-Id` / `X-Tenant-Id`，否则 401 |
| 能否照搬 Codex 的做法（spawn 官方进程 + JSON-RPC） | **不能**。取数走的是内部 stdio RPC（`auth:getAccountUsage`，经 fd3/fd4），外部进程无法稳定接入 |
| 能否从本地文件读到 token | **大概率可以**。WorkBuddy 把登录会话**刻意**放在一个与 CLI 子进程共享的文件里（源码注释原文：*"Stores authentication session in a shared location that can be accessed by CLI subprocesses"*）：`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info` |
| 真正的卡点 | **该文件里的 `auth.accessToken` / `auth.refreshToken` 可能被"静态加密"** —— 取决于环境变量 `WORKBUDDY_AT_REST_ENCRYPTION`。默认（未设置）= `disabled` = 明文，但**必须实测确认**（见第 4 节 A0 与第 7 节命令） |
| 与 Qoder 的关键差异 | Qoder 那边的卡点「token 从哪来」在 WorkBuddy 这里有解 —— 官方就是把会话文件设计成可被外部进程读取的。所以 WorkBuddy 比 Qoder 更可能直接跑通 |

---

## 2. 主接口：`/billing/meter/get-user-resource-summary`

### 证据来源

应用内置代码 `packages/agent-provider/src/backend/*`：

```js
/** api1：余额/档位/付费状态聚合，无业务参数。#97550 三个新接口的网关路由不带 `/v2` */
async fetchResourceSummary(endpoint, headers) {
  const response = await this.http.post(`${endpoint}/billing/meter/get-user-resource-summary`, {}, { headers });
  if (!response.data?.data) throw new UserResourceRequestError("get-user-resource-summary returned no data", { retriable: true });
  return parseResourceSummary(response.data.data);
}
```

`endpoint` 来自 `productManager.getEndpoint().replace(/\/+$/, "")`；本机产品配置里的值是 `https://copilot.tencent.com`
（`officialEndpoints` = `https://copilot.tencent.com`、`https://staging-copilot.tencent.com`、`https://www.codebuddy.ai`、`https://staging-codebuddy.tencent.com`）。

### 请求

```
POST {endpoint}/billing/meter/get-user-resource-summary
Content-Type: application/json
Accept: application/json
Authorization: Bearer <accessToken>
X-User-Id: <uid>
(企业账号) X-Enterprise-Id / X-Tenant-Id: <enterpriseId>
Accept-Language: zh

{}          ← body 是空对象，不带任何业务参数
```

### 响应

envelope 为 `{ code, msg, data }`，`code === 0` 才算成功，`data` 缺失即视为失败。

```jsonc
{
  "code": 0,
  "msg": "",
  "data": {
    "Packages": [
      {
        "PackageCode": "TCACA_code_001_PqouKr6QWV",
        "CycleTotalCapacity": 1000,
        "CycleRemainCapacity": 742,
        "CycleUsedCapacity": 258
      }
    ],
    "SubscriptionPackageCode": "...",
    "IsPaidUser": false
  }
}
```

官方解析函数（**照抄，不要自创**）：

```js
/** 把 api1 回包映射为内部结构；缺字段按空/0 处理，不抛错 */
function parseResourceSummary(raw) {
  return {
    packages: (raw?.Packages ?? []).map(item => ({
      packageCode:  item?.PackageCode ?? "",
      cycleTotal:   toCount(item?.CycleTotalCapacity),
      cycleRemain:  toCount(item?.CycleRemainCapacity),
      cycleUsed:    toCount(item?.CycleUsedCapacity)
    })),
    subscriptionPackageCode: raw?.SubscriptionPackageCode ?? "",
    isPaidUser: !!raw?.IsPaidUser
  };
}
// toCount(v) = Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0
```

### 数值语义（必须照抄应用的算法）

- **剩余积分**：对 `summary.packages` 求和 —— 源码注释明确说明：*"服务端已做订阅去重与免费月包过滤，所以这里是无条件求和 —— 不能再套 `excludeSuppressedPlanBase`，那会把已剔除的低档包二次剔除，余额偏少。"*
  ```
  left  = Σ max(0, cycleRemain)
  total = Σ max(0, cycleTotal)
  used  = Σ max(0, cycleUsed)
  ```
- **失败判定**：`!data` → 可重试。HTTP `408 / 429 / >=500` 或拿不到状态码 → 可重试；`4xx` → 稳定失败，**不要重试**。
- **重试策略**（官方 `withRetry`）：最多 3 次，退避 `min(1000 * 2^(n-1), 8000) ms` 带 ±30% jitter。
- **单个池子为 0 或缺失**：按官方口径当作 0，但**整体三路全失败时官方拒绝上报**（`"refusing to report incomplete credits"`）→ 我们也应显示缺失态，而不是显示 0。
- **企业不限量**：`"unlimited"` 是字符串哨兵（`UNLIMITED_USAGE_SENTINEL`），前端要显示"不限量"，不可当数字解析。
- **格式**：整数直接显示，非整数保留 2 位小数（官方 `formatCredit`）。

---

## 3. 其他相关接口

| 接口 | 用途 | 结论 |
| --- | --- | --- |
| `POST {endpoint}/billing/meter/get-user-resource-paid-packages` | 付费包明细（api2） | 做「明细展开」时需要。body：`{PageNumber, PageSize:200, PackageCodes:[付费码], Status:[0,3], NeedRenewInfo:true}`；响应 `{code,msg,data:{Accounts:[],TotalCount}}` |
| `POST {endpoint}/billing/meter/get-user-resource-free-packages` | 免费包 / 切片额度明细（api3） | 同上，但 `Status:[0,3]` + 当日切片窗口 `SlicePeriodStartTime`/`SlicePeriodEndTime`（格式 `yyyy-MM-dd HH:mm:ss`，口径 00:00:00~23:59:59） |
| `POST {endpoint}/v2/billing/meter/get-enterprise-user-usage` | 企业 / IOA / 旗舰 / 专享账号的用量 | **企业账号的正解**（见 §3.1）。个人账号不要走这条 |
| `POST {endpoint}/v2/billing/meter/get-user-resource` | 旧版用量聚合 | 老链路，**需要 `/v2` 前缀**。新三接口已取代它，不建议使用 |
| `GET {endpoint}/v2/as/genie-baas/user/quota/check` | 云服务（genie-baas）用户配额 | 与「AI 积分」不是同一个池子，容易误用。前缀常量 `GENIE_BAAS_API_BASE = "/v2/as/genie-baas"` |
| `GET {endpoint}/v2/activity/ambassador/status` | 大使身份 | 只返回 `isAmbassador`，无积分 |
| `GET {endpoint}/activity/workbuddy/invitation/v2/invite-records` | 邀请记录 | `total_credits` 等是**邀请奖励**，不是余额 |
| `/billing/pay/get-price`、`/billing/pay/create-order`、`/billing/pay/set-renew-flag` | 询价 / 下单 / 续费 | **写操作**，绝对不要调用。且**企业账号不适用**（官方注释：企业账号不在个人计费体系内，询价必然失败） |
| 本地 SQLite `~/.workbuddy/workbuddy.db` → `session_usage` | 每次请求已消耗的 credit | 无鉴权可读，但**是消耗不是余额**，只适合交叉校验/趋势（见 §4 D） |

> `PackageCodes` 常量（api2 / api3 用），与源码 `CommodityCode` 一致：
>
> - 付费（api2）：`proMon, proMonPlus, proYear, youth, advanced, flagship, extra, extra38, extraIntl`
> - 免费（api3）：`free, freeMon, freeMonIntl, gift, proTrialMon, proTrialYear, activity, bonus28, bonusIntl, bonus29, bonus30`
> - 实际值例：`free = TCACA_code_001_PqouKr6QWV`、`proMon = TCACA_code_002_AkiJS3ZHF5`、`freeMon = TCACA_code_008_cfWoLwvjU4`、`extra = TCACA_code_009_0XmEQc2xOf`、`youth = TCACA_code_023_4xbGhMrE6q`、`advanced = TCACA_code_026_BaESVICNoi`、`flagship = TCACA_code_027_0FCGVA6vSa`。

### 3.1 企业账号：`/v2/billing/meter/get-enterprise-user-usage`

```js
const response = await this.http.post(`${endpoint}/v2/billing/meter/get-enterprise-user-usage`, {}, { headers: this.buildHeaders(session) });
const usageData = response.data?.data?.data || response.data?.data || response.data;   // 三层兜底
if (usageData.limitNum === -1) {                       // 不限量
  usageLeft = usageTotal = "unlimited";
} else {
  usageLeft  = String(usageData.limitNum - usageData.credit);
  usageTotal = String(usageData.limitNum);
}
// refreshAt = usageData.cycleResetTime ? new Date(usageData.cycleResetTime).getTime() : undefined
```

字段：`limitNum`（`-1` = 不限量）、`credit`、`cycleResetTime`。

### 3.2 ⚠️ 路径前缀是最容易踩的坑

源码 `CloudAccountRepo` 的三套前缀，注释原文：

- `billingPrefix`：Web 端空串，**Desktop 覆盖为 `/v2`** → 老接口 `get-user-resource` 走这条
- `payPrefix`：两端都空串 → `/billing/pay/*`
- `resourcePrefix`：**两端都空串** → 新三接口 `get-user-resource-summary / -paid-packages / -free-packages` 的网关路由声明的是无前缀路径

而企业接口 `get-enterprise-user-usage` 是**带 `/v2`** 的。所以：

```
/billing/meter/get-user-resource-summary          ← 无 /v2
/billing/meter/get-user-resource-paid-packages    ← 无 /v2
/billing/meter/get-user-resource-free-packages    ← 无 /v2
/v2/billing/meter/get-enterprise-user-usage       ← 有 /v2
/v2/billing/meter/get-user-resource                ← 有 /v2（旧）
```

---

## 4. 待决问题：accessToken 从哪来

接口已定，唯一缺口是认证。WorkBuddy 的情况比 Qoder 好：**官方把会话文件放在了外部可读的位置**。

### A0. 先做这一步：确认会话文件里的 token 是不是明文（**卡点**）

会话文件路径（三层推导，全部来自源码常量）：

| 环节 | 值 | 来源 |
| --- | --- | --- |
| `EXTENSION_DATA_DIR_NAME` | `CodeBuddyExtension` | `packages/core/src/node/file-path-service.ts` |
| win32 `basePath` | `path.join(homedir, "AppData", "Local", EXTENSION_DATA_DIR_NAME)` | 同上 |
| `sharedDataPath` | `path.join(basePath, "Data", "Public")` | 同上 |
| `authenticationId` | 产品配置 `authentication.id` = **`workbuddy-desktop`** | `acc-product-config-v3.json` |
| 最终路径 | `path.join(sharedDataPath, "auth", \`${authenticationId}.info\`)` | `file-authentication-storage.ts` |

本机最终路径：

```
C:\Users\KEy\AppData\Local\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
```

（本次调研尝试读取该目录时被沙箱拦截、用户未授权，因此**没有实测值**，请在验证阶段自行确认。）

文件是 JSON（`JSON.stringify(persisted, null, 2)`），顶层即 session 对象，含 `auth` 与 `account` 两棵子树。经代码确认的字段路径：

| 用途 | 字段路径 |
| --- | --- |
| accessToken | `auth.accessToken` |
| refreshToken | `auth.refreshToken` |
| domain（→ `X-Domain` 头） | `auth.domain` |
| uid（→ `X-User-Id` 头） | `account.uid` |
| enterpriseId（→ `X-Enterprise-Id` / `X-Tenant-Id`） | `account.enterpriseId` |
| 部门信息（可选头） | `account.departmentFullName` |

**风险点**：源码 `AUTH_CREDENTIAL_FIELDS` 只声明了两个被"字段级静态加密"保护的字段 —— `["auth","accessToken"]` 与 `["auth","refreshToken"]`（其余字段始终明文）。是否加密由环境变量控制：

```
WORKBUDDY_AT_REST_ENCRYPTION = "required" | "disabled"     // 其它值/未设置 → 按 "disabled"
```

- `required` 且密钥可用 → 密文落盘，外部读取需要密钥 → **方案 A 不可用**。
- `disabled`（默认）→ 字段按**明文 JSON 字符串**落盘 → 直接 `JSON.parse` 就能用。
- 本机 `~/.workbuddy/security/at-rest-failures-v1.json` 的 `entries` 为空数组，**倾向于**说明当前没有加密失败，但**不能据此断定模式**。

另外两点必须在实现里处理：

1. **登出标记**：同目录有 `getLogoutMarkerPath(filePath)` 派生的登出标记文件。**它存在时，会话文件必须视为无效**，直接返回「未登录」，不要发请求。
2. **token 会被后台刷新**：官方 `AuthService` 订阅会话变化并 `invalidateAccountUsageCache()`，refreshToken 会轮换。所以**不要长期缓存 token**，每次刷新积分时重读一次会话文件。

### A. 读共享会话文件 + 直连 HTTP（推荐）

- 优点：官方设计使然（文件明说"可被 CLI 子进程访问"），不触碰任何加密凭据存储，不需要逆向登录协议。
- 前置：A0 确认 token 是明文。
- 失败边界：文件不存在 / 登出标记存在 / token 为密封结构 → 显示「需要登录 WorkBuddy」，不静默重试。

### B. 用户手动粘贴 token（保底）

设置里给一个输入框，粘贴一次 accessToken / uid。只存内存或系统凭据管理器，**不写日志、不进配置明文、不打印**（沿用 README 里 Codex 的凭据纪律）。缺点：token 过期要重新粘。

### C. 不推荐：走官方内部 RPC

官方 renderer 通过 stdio（fd3/fd4）调用 RPC channel `auth:getAccountUsage`（日志中可见 `[MainBootstrap] [StdioConn] ... "channel":"auth:getAccountUsage"`）。这是主进程/daemon 之间的内部协议，需要复现握手与 fd 传递，脆弱且随版本变。仅作线索记录。

### D. 明确排除的路径

- **不要**去解密 at-rest 凭据（若 A0 发现是密文）。
- **不要**调用任何 `/billing/pay/*` 写接口。
- **不要**读取/复制/打印 token 到日志、遥测或崩溃报告。
- 不要把 `session_usage`（消耗量）当余额用。

---

## 5. 实现落点（确认后执行）

1. **新增独立只读适配器**，不与 Codex 共用认证状态（`HANDOFF.md` 既有约束）：
   - `src-tauri/src/workbuddy_credits.rs`：
     - 用 `std::env::var("LOCALAPPDATA")` 拼路径，**不要硬编码用户名**。
     - 检查登出标记 → 存在即返回 `NotLoggedIn`。
     - 解析会话 JSON，取 `auth.accessToken` / `account.uid` / `account.enterpriseId`。
     - 分支：`enterpriseId` 非空 → `POST {endpoint}/v2/billing/meter/get-enterprise-user-usage`；否则 → `POST {endpoint}/billing/meter/get-user-resource-summary`。
     - 只读请求最多重试 2 次、间隔 3 s（与 Codex 一致）；4xx 不重试。
     - **token 只在内存中持有**，绝不打印、不落盘、不写日志。
   - `{endpoint}` 取值顺序：① 环境变量覆盖（便于测试/海外版）；② 读 `~/.workbuddy/cache/acc-product-config-v3.json` 的 `endpoint` 字段（该文件是产品能力配置，**不含 token**）；③ 硬编码兜底 `https://copilot.tencent.com`。
   - **Rust 反序列化注意（吸取 Codex 那次的教训）**：本接口字段是 **PascalCase**（`Packages[].CycleRemainCapacity`），既不是 camelCase 也不是 snake_case。每个字段加 `#[serde(rename = "...")]`，并**全部用 `Option<T>`**，缺字段按 0 处理而不是反序列化失败。输出给前端保持 snake_case。
2. **探针脚本** `scripts/probe-workbuddy.mjs`（对标 `scripts/probe-codex.mjs`）：只输出白名单字段（`code`、`packages.length`、`cycleRemain` 合计、`IsPaidUser`、是否走企业分支），**绝不** dump 原始响应、token、uid、headers。支持 `--endpoint` 覆盖与 `--enterprise` 强制分支。
3. **前端** `src/main.js`：多一行 `WorkBuddy`，按设计稿显示 `2,450 积分`（千分位；**积分不带进度条**，进度条只给 Codex 百分比用，见 `docs/superpowers/specs/2026-09-27-multi-service-quota-floating-widget-design.md`）；低额度只把该数值改暖色；企业不限量显示「不限量」。
4. **测试**：`cargo test` 加两段 —— ① fixture 解析（`Packages` 正常/空数组/字段缺失、`IsPaidUser`、企业 `limitNum === -1`、企业 `limitNum - credit`）；② `#[ignore]` 的联机用例，仅断言 `code === 0` 且 `Σ cycleRemain >= 0`，不打印数值与凭据。
5. **节流**：官方自己对 `getAccountUsage` 都有 **5 s TTL 缓存 + 单飞去重**，且一次轮询会打 4 个 HTTP。我们的刷新间隔建议 **≥ 5 分钟**。

---

## 6. 需要用户回答的问题（实现前必须确认）

1. 你的 WorkBuddy 账号是**个人版**还是**企业/IOA 成员**？（决定走 `/billing/meter/get-user-resource-summary` 还是 `/v2/billing/meter/get-enterprise-user-usage`。本机 `~/.workbuddy/storage/skeleton/account-snapshot.json` 显示 `type: "personal"`、`editionType: "free"`，但若登录态已变化需重新确认。）
2. 是否接受方案 A（读 WorkBuddy 自己写下的共享会话文件 + 直连官方接口）？这是当前唯一不需要逆向凭据的路线，前提是 A0 验证 token 为明文。
3. 若 A0 发现 token 是密文、或你不希望程序去读那个文件，是否接受方案 B（手动粘贴 token）作为第一版？
4. 「剩余积分」的口径：只用 api1 的 `summary` 求和（轻，1 个请求），还是照官方三路并行合并（准，3 个请求，含免费包/切片包明细）？
5. 单位显示：整数积分是否保留小数？（官方 `total/used/remain` 都是数字，可能出现小数。）

---

## 7. 复现验证命令

### 7.1 确认 token 是明文还是密文

```powershell
$p = Join-Path $env:LOCALAPPDATA "CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info"
Get-ChildItem (Split-Path $p) | Select-Object Name, Length          # 顺便看有无登出标记文件
(Get-Content $p -Raw | ConvertFrom-Json).auth.PSObject.Properties |
  Select-Object Name, @{n='Type';e={$_.Value.GetType().Name}}
```

- `accessToken` 的 `Type` 为 `String` 且以常见 token 前缀开头 → **明文，方案 A 可行**。
- 为 `PSCustomObject` / 含 `data` 字段的密封结构 → **密文，改走方案 B**。

### 7.2 主接口（个人版）

```powershell
$endpoint = "https://copilot.tencent.com"
$token    = "<粘贴 accessToken>"
$uid      = "<粘贴 account.uid>"
$headers  = @{
  "Accept"          = "application/json"
  "Authorization"   = "Bearer $token"
  "X-User-Id"       = $uid
  "Content-Type"    = "application/json"
  "Accept-Language" = "zh"
}
Invoke-RestMethod -Method Post `
  -Uri "$endpoint/billing/meter/get-user-resource-summary" `
  -Headers $headers -Body "{}" | ConvertTo-Json -Depth 8
```

期望：`code = 0`，`data.Packages[]` 里能看到 `CycleRemainCapacity`；各包 `CycleRemainCapacity` 相加 = 剩余积分（与 WorkBuddy 界面上显示的数字对一下）。

### 7.3 企业接口（仅企业账号）

```powershell
$headers["X-Enterprise-Id"] = "<enterpriseId>"
$headers["X-Tenant-Id"]     = "<enterpriseId>"
Invoke-RestMethod -Method Post `
  -Uri "$endpoint/v2/billing/meter/get-enterprise-user-usage" `
  -Headers $headers -Body "{}" | ConvertTo-Json -Depth 8
```

### 7.4 无鉴权的本地交叉校验（不需要 token）

```powershell
# 已消耗积分（不是余额）
$py = "C:\Users\KEy\.workbuddy\binaries\python\versions\3.13.12\python.exe"
& $py -c "import sqlite3;c=sqlite3.connect('file:C:/Users/KEy/.workbuddy/workbuddy.db?mode=ro',uri=True);print(c.execute('select session_id,updated_at,credit_json from session_usage order by updated_at desc limit 5').fetchall())"
```

拿到真实响应后，把 JSON 的**字段名**（去掉数值）补进本文档第 2 节，然后才开始写解析代码。

---

## 8. 附：取证证据索引

| 结论 | 证据位置 |
| --- | --- |
| `endpoint = https://copilot.tencent.com` | `~/.workbuddy/cache/acc-product-config-v3.json` 的 `endpoint` / `officialEndpoints` |
| `authentication.id = "workbuddy-desktop"` | 同上 `authentication.id` |
| `EXTENSION_DATA_DIR_NAME = "CodeBuddyExtension"` | `app.asar` → `packages/core/src/node/file-path-service.ts` |
| 会话文件 = `<sharedData>/auth/<id>.info` | `app.asar` → `packages/workbuddy-server/src/auth/file-authentication-storage.ts` |
| `AUTH_CREDENTIAL_FIELDS = [["auth","accessToken"],["auth","refreshToken"]]` | `app.asar` → `packages/core/src/node/credential-protection/*` |
| at-rest 开关 `WORKBUDDY_AT_REST_ENCRYPTION`，默认 `disabled` | `app.asar` → `workbuddy-server/src/server/credential-protection-bootstrap.ts` |
| `buildAuthHeaders` 头集合 | `app.asar` → `AuthenticationManager.buildAuthHeaders`（`X-User-Id` / `Authorization` / `X-Enterprise-Id` / `X-Tenant-Id` / `X-Domain`） |
| `POST {endpoint}/billing/meter/get-user-resource-summary` | `app.asar` → `agent-provider/src/backend` 的 `fetchResourceSummary` |
| 三接口无 `/v2`、旧接口要 `/v2` | `app.asar` → `CloudAccountRepo` 的 `resourcePrefix` / `billingPrefix` 注释（Issue #97550） |
| `POST {endpoint}/v2/billing/meter/get-enterprise-user-usage`、`limitNum - credit`、`-1 → "unlimited"` | `app.asar` → `AuthService.getEnterpriseUsage` |
| `Σ CycleRemainCapacity` 求和规则 | `app.asar` → `sumSummaryCapacity`（含"无条件求和"注释） |
| 切片包优先读切片明细、缺则回落周期额度 | `app.asar` → `resolveResourceCapacity`（Issue #105166） |
| 5 s TTL + 单飞、失败不落负缓存 | `app.asar` → `ACCOUNT_USAGE_CACHE_TTL_MS` 注释 |
| 三路取数失败则拒绝上报 | `app.asar` → `getPersonalUsage`（`"refusing to report incomplete credits"`） |
| RPC channel `auth:getAccountUsage` | `~/.workbuddy/logs/main.log`（`[StdioConn]` 日志） |
| `session_usage(session_id, used, size, updated_at, credit_json)` | `~/.workbuddy/workbuddy.db`（只读查 `sqlite_master`） |

---

## 9. 下一步（按顺序）

1. 跑 §7.1，确认 token 明文/密文 → **这一步决定方案 A 是否可行**。
2. 跑 §7.2，确认接口通、字段名对、剩余积分数值与 WorkBuddy 界面一致。
3. 写 `scripts/probe-workbuddy.mjs`（只读诊断，白名单输出）。
4. 写 Rust 适配器 `workbuddy_credits.rs` + 前端 WorkBuddy 行。
5. 在 `HANDOFF.md` 的「后续工作」里把 WorkBuddy 从「待加入」改为「已接入」，并注明用的是哪条接口。
