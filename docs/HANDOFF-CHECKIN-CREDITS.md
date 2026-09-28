# Handoff：签到领积分 —— 入口调研与实现方案

状态：**调研文档，未改动任何代码，未调用任何「领取」接口**。所有在线探测均为只读（GET 与 status 查询），只记录 HTTP 状态码与响应字段名/类型，未记录任何 token、数值或原始响应。

调研时间：2026-09-28。环境：Windows。
取证来源：本机应用包（WorkBuddy `app.asar`、TRAE SOLO CN `resources/app/out/*.js` 与 `product.json`、Qoder CN 0.4.3 `app.asar`）、Qoder 官网前端 bundle，以及对三家接口的只读探测。

---

## 0. 结论速览

| 服务 | 是否有签到 | 状态接口（只读） | 领取接口（写操作，未调用） | QuotaHalo 现有凭据 | 结论 |
| --- | --- | --- | --- | --- | --- |
| WorkBuddy | 有：每日签到 + 连续奖励 | `POST /v2/billing/meter/checkin-activity-status`（实测 200） | `POST /v2/billing/meter/daily-checkin` | 直接可用（本机明文 token，实测成功） | **可以做** |
| TRAE | 有：签到积分 | `POST api.trae.cn/trae/api/v2/ug/checkin_credits/status`（实测 200，无需 cookie） | `POST .../checkin_credits/claim` | 直接可用（trae-token 实测成功） | **可以做** |
| Qoder | **无签到**，只有运营活动 | `GET /sash/api/v1/me/campaigns`（实测 200，本账号 campaigns 为空） | 桌面端无领取 API，领取在活动网页内完成 | 可读（jt- 链路） | 只能做「可领提醒 + 打开活动页」 |

**仓库现状**：全仓检索 `签到|领取|claim|campaign|checkin|check_in|sign_in|daily`，仅 `docs/HANDOFF-QODER-CREDITS.md:78` 命中一行记录，代码、UI、托盘菜单中没有任何签到/领取入口。

---

## 1. WorkBuddy（腾讯 CodeBuddy）：有完整每日签到

### 1.1 接口

| 用途 | 请求 | 证据 |
| --- | --- | --- |
| 查询签到状态 | `POST https://copilot.tencent.com/v2/billing/meter/checkin-activity-status`，body `{}` | 实测 200；`app.asar` 内 `getCheckinStatus()` |
| 查询签到状态（旧链路） | `POST https://copilot.tencent.com/billing/meter/checkin-status`，body `{}` | 实测 200，字段与 v2 版一致（`checkin_dates` 为 null） |
| 执行签到 | `POST https://copilot.tencent.com/v2/billing/meter/daily-checkin`，body `{}` | `app.asar` 内 `claimDailyCheckin()`；**写操作，本次未调用** |
| 另一套活动 | `POST /activity/growth/buddy/travel/claim` | 「出行到达奖励积分」，与每日签到无关 |

### 1.2 认证（与额度读取完全相同）

```
Authorization: Bearer <accessToken>
X-User-Id: <uid>
(企业账号) X-Enterprise-Id / X-Tenant-Id: <enterpriseId>
(auth.domain 存在时) X-Domain: <domain>
```

- 凭据来源：`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`（本机实测为**明文 JSON**，同目录无 `.logout` 标记 = 已登录）。QuotaHalo 的 `workbuddy_credits.rs` 已在用这条路径。
- **领取的额外要求**：官方 `buildHeadersWithTuringToken(session)` 会为签到接口注入腾讯 Turing 设备风控 token（`TURING_SHIELD_ID_HEADER`）；取不到时改注入一个 error 头**仍然发送请求**。→「无风控头能否领取成功」是唯一未验证项。

### 1.3 状态响应结构（实测字段名）

```
{ code, msg, requestId, data: {
    active, today_checked_in, streak_days, daily_credit, today_credit,
    is_streak_day, next_streak_day, streak_bonus_days, streak_bonus_credit,
    checkin_dates: [string], week_checkin_days, week_progress: [bool],
    total_credits, start_time, end_time, theme_name, season,
    activity_name, claim_button_text,
    action_button: { show, text, action }
} }
```

### 1.4 领取结果语义（照抄官方实现）

- 成功：`{ status: claimed, credit, streakDays, isStreakDay }`。
- 失败：按数字 `code` 映射（`mapCheckinStatus`）：`1001 → already_claimed`、`1002 → not_eligible`、…、`event_ended`、`unknown_biz_error`（1002 之后的码表未展开）。
- 版本开关：ProductFeature `DisableCheckin`（无积分体系的发行版隐藏入口，如海外版）。

---

## 2. TRAE：有签到积分接口

### 2.1 接口

| 用途 | 请求 | 证据 |
| --- | --- | --- |
| 查询签到状态 | `POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/status`，body `{"req_source":1}` | 实测 200；TRAE 主进程包 `fetchCheckinCreditsStatus()` |
| 执行签到 | `POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim`，body 同上 | 主进程包 `claimCheckinCredits()`；**写操作，本次未调用** |

- 基址判定：`api.trae.com.cn` 返回 **404**；正确基址是 `api.trae.cn`（TRAE `product.json` → `ug.trae.normal = https://api.trae.cn`）。
- `req_source`：客户端取 `2`（lite）/ `1`，实测 `1` 可用。

### 2.2 认证（沿用现有 trae-token，无需 cookie）

```
Authorization: Cloud-IDE-JWT <trae-token>
Content-Type: application/json
```

- 来源：`mixAuthorization()`（`Cloud-IDE-JWT ${token}`）。
- 官方客户端还会带 `x-device-id / x-device-brand / x-device-type / x-os-version / x-app-version`；**实测状态查询不带也能成功**。
- QuotaHalo 已存 `QuotaHalo/trae-token`（Cloud-IDE-JWT）与 `QuotaHalo/trae-session`，实测仅用前者即 200，cookie 可有可无。
- 客户端门槛：CN + `account.scope === MARSCODE`（普通个人账号），否则抛 `Checkin credits is unavailable`。

### 2.3 状态响应结构（实测字段名）

```
{ enable, checked_in, did_checked_in, credits, extra_credits, code, message }
```

- `enable`=活动可用；`checked_in`=今天是否已签；`credits`=本次可得（>0 才由客户端保留）。
- 领取成功判定：HTTP 200 且（无 `code` 字段或 `code === 0`）。

---

## 3. Qoder：没有签到，只有运营活动

- 桌面端活动服务（0.4.3 `app.asar`）只做三件事：查状态、查限量编号、打开活动页；**没有任何 claim 接口**。
  - `GET https://openapi.qoder.com.cn/sash/api/v1/me/campaigns` → 实测 200，结构：`{ uid, showCampaign, claimable, campaignUrl, campaigns: [] }`（本账号活动数组为空 = 当前无可领活动）。
  - `GET /sash/api/v1/me/campaigns/client_launch_26/limited-number` → 实测 200，结构：`{ hasNumber, number, createdAt }`。
  - 客户端 `openSurface` 只负责把 `campaignUrl` 在应用内 WebView 打开，**领取动作在活动网页内完成**。
- 官网 bundle（`g.alicdn.com/qbase/qoder/0.0.711/index.js`）确认存在「新用户积分领取 + 邀请奖励」计划（条款路径 `product-overview/qoderwork-cn-new-user-credits-claim-and-referral-reward-program-terms-and-conditions`、`referral_code` 参数），但领取 API 不在该主包内（应在活动页自己的 chunk / 独立前端里）。
- 结论：Qoder 做不了「一键签到」；可做的是「可领状态提醒 + 打开活动页」。
- 认证沿用现有链路：PAT → `POST /api/v1/jobToken/exchange` → `jt-` 令牌（本次探测走的就是这条）。

---

## 4. 实现方案（供决策，尚未实施）

### 4.1 建议分两期

- **第一期（只读，零风险）**：主界面显示「今日未签到」标记（或托盘提示），点击后打开对应客户端/网页。WorkBuddy 与 TRAE 用各自 status 接口（现有凭据即可），Qoder 用 campaigns。改动可参照现有 `refresh_qoder` 模式：`external_credits.rs`（新增 checkin 查询）→ `main.rs`（新 command）→ `index.html/main.js`（角标 + 文案）。
- **第二期（写操作，需用户确认后做）**：加「签到」按钮 / 托盘菜单项，调用 claim。需要新增：二次确认、结果反馈（claimed / already_claimed / not_eligible…）、成功后自动刷新积分。TRAE 风险低（纯 HTTP 头即可）；WorkBuddy 需先实测无 Turing 头能否领取。

### 4.2 建议数据结构

```rust
struct CheckinSnapshot {
    status: String,        // ready | missing
    checked_in: bool,      // 今天是否已签
    credits_today: Option<f64>,
    streak_days: Option<u32>,
    message: Option<String>,
}
```

沿用 `CreditSnapshot` 的 missing/ready 口径，不新增错误通道。

### 4.3 注意事项

- 自动化签到可能触及各家用户协议与风控：建议**只做「用户显式点击 + 每日一次」**，不做后台静默定时领取。
- 官方客户端都带风控标识（WorkBuddy Turing token、TRAE `x-device-*`）；我们跳过它们属于旁路，需接受被拒绝或被风控的后果。
- Qoder 若未来要做活动领取，需先摸清活动页自身的接口（当前未知）。

---

## 5. 未验证项

1. **WorkBuddy `daily-checkin` 无 Turing 风控头是否可用**（唯一阻塞项，只能由用户授权后实测一次）。
2. TRAE `claim` 与 `status` 是否同一鉴权（大概率一致，未实测）。
3. 三家接口的频率限制；WorkBuddy `mapCheckinStatus` 官方码表后半段未展开。
4. Qoder 活动页的领取接口（未定位）。

## 6. 复现方式（只读）

探针纪律：只输出 HTTP 状态 + 字段名/类型，绝不记录 token、数值或原始响应；不调用任何 claim。

- WorkBuddy：读 `workbuddy-desktop.info` → 取 `auth.accessToken`/`account.uid` → `POST /v2/billing/meter/checkin-activity-status`。
- TRAE：Windows 凭据管理器 `QuotaHalo/trae-token` → `POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/status`。
- Qoder：`QuotaHalo/qoder-pat` → `POST /api/v1/jobToken/exchange` → `GET /sash/api/v1/me/campaigns`。