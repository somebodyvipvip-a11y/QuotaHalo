const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const appWindow = window.__TAURI__.window.getCurrentWindow();

const elements = {
  timezone: document.querySelector("#timezone"),
  quotaContent: document.querySelector("#quota-content"),
  errorContent: document.querySelector("#error-content"),
  errorMessage: document.querySelector("#error-message"),
  primaryRing: document.querySelector("#primary-ring"),
  primaryReset: document.querySelector("#primary-reset"),
  primaryRemaining: document.querySelector("#primary-remaining"),
  primaryProgress: document.querySelector("#primary-progress"),
  primaryCountdown: document.querySelector("#primary-countdown"),
  weeklyRemaining: document.querySelector("#weekly-remaining"),
  weeklyProgress: document.querySelector("#weekly-progress"),
  weeklyReset: document.querySelector("#weekly-reset"),
  miniContent: document.querySelector("#mini-content"),
  miniRing: document.querySelector("#mini-ring"),
  miniRemaining: document.querySelector("#mini-remaining"),
  miniProgress: document.querySelector("#mini-ring-progress"),
  miniCountdown: document.querySelector("#mini-countdown"),
  miniReset: document.querySelector("#mini-reset"),
  exitCompact: document.querySelector("#exit-compact"),
  minimize: document.querySelector("#minimize"),
  closePanel: document.querySelector("#close-panel"),
  miniClosePanel: document.querySelector("#mini-close-panel"),
  updatedAt: document.querySelector("#updated-at"),
  refresh: document.querySelector("#refresh"),
  settings: document.querySelector("#settings"),
  settingsBack: document.querySelector("#settings-back"),
  compactToggle: document.querySelector("#compact-toggle"),
  settingsPanel: document.querySelector("#settings-panel"),
  panelHeader: document.querySelector(".panel-header"),
  panelFooter: document.querySelector(".panel-footer"),
  creditsContent: document.querySelector("#credits-content"),
  showUnloggedCredits: document.querySelector("#show-unlogged-credits"),
  creditVisibility: Object.fromEntries(["workbuddy", "trae", "qoder"].map((name) => [name, document.querySelector(`#show-${name}-credit`)])),
  opacity: document.querySelector("#opacity"),
  opacityValue: document.querySelector("#opacity-value"),
  openUsage: document.querySelector("#open-usage"),
  qoderToken: document.querySelector("#qoder-token"),
  traeSecret: document.querySelector("#trae-secret"),
  saveQoder: document.querySelector("#save-qoder"),
  saveTrae: document.querySelector("#save-trae"),
  loginTrae: document.querySelector("#login-trae"),
  forgetQoder: document.querySelector("#forget-qoder"),
  forgetTrae: document.querySelector("#forget-trae"),
  qoderConnection: document.querySelector("#qoder-connection"),
  traeConnection: document.querySelector("#trae-connection"),
  connectionMessages: {
    qoder: document.querySelector("#qoder-message"),
    trae: document.querySelector("#trae-message"),
  },
  credits: Object.fromEntries(["workbuddy", "trae", "qoder"].map((name) => [name, {
    row: document.querySelector(`[data-service="${name}"]`),
    value: document.querySelector(`#${name}-remaining`),
    detail: document.querySelector(`#${name}-detail`),
  }])),
};

let snapshot = null;
let lastSuccessfulSnapshot = null;
let refreshing = false;
let settingsViewOpen = false;
let codexRequestId = 0;
const creditSnapshots = {};
const creditRequestIds = { workbuddy: 0, trae: 0, qoder: 0 };
const AUTO_REFRESH_INTERVAL_MS = 180_000;
const CREDIT_REFRESH_INTERVAL_MS = 300_000;
const REFRESH_DEADLINE_MS = 50_500;
const THEME_STORAGE_KEY = "quota-halo-skin";
const OPACITY_STORAGE_KEY = "quota-halo-opacity";
const MODE_STORAGE_KEY = "quota-halo-display-mode";
const CREDIT_VISIBILITY_STORAGE_KEY = "quota-halo-credit-visibility";
const THEME_LABELS = { violet: "紫晶", blue: "湛蓝", mint: "青绿", amber: "琥珀" };
const THEMES = new Set(Object.keys(THEME_LABELS));
const DEFAULT_CREDIT_VISIBILITY = { showUnlogged: false, workbuddy: true, trae: true, qoder: true };

function readCreditVisibility() {
  try {
    const stored = JSON.parse(localStorage.getItem(CREDIT_VISIBILITY_STORAGE_KEY) || "null");
    return { ...DEFAULT_CREDIT_VISIBILITY, ...(stored && typeof stored === "object" ? stored : {}) };
  } catch { return { ...DEFAULT_CREDIT_VISIBILITY }; }
}

let creditVisibility = readCreditVisibility();

function applyCreditVisibility(next = creditVisibility, persist = true) {
  creditVisibility = { ...DEFAULT_CREDIT_VISIBILITY, ...next };
  elements.showUnloggedCredits.checked = creditVisibility.showUnlogged;
  Object.entries(elements.creditVisibility).forEach(([name, checkbox]) => { checkbox.checked = creditVisibility[name]; });
  ["workbuddy", "trae", "qoder"].forEach(renderCreditVisibility);
  if (persist) {
    try { localStorage.setItem(CREDIT_VISIBILITY_STORAGE_KEY, JSON.stringify(creditVisibility)); } catch { /* storage unavailable */ }
  }
}

function applyTheme(theme, persist = true) {
  const selected = THEMES.has(theme) ? theme : "violet";
  document.body.dataset.theme = selected === "violet" ? "" : selected;
  document.querySelectorAll(".theme-choice").forEach((choice) => {
    choice.classList.toggle("is-active", choice.dataset.theme === selected);
  });
  if (persist) {
    try { localStorage.setItem(THEME_STORAGE_KEY, selected); } catch { /* storage unavailable */ }
  }
}

try { applyTheme(localStorage.getItem(THEME_STORAGE_KEY) || "violet", false); } catch { applyTheme("violet", false); }

function normalizeOpacity(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 100;
  return Math.max(60, Math.min(100, Math.round(number / 5) * 5));
}

function applyOpacity(value, persist = true) {
  const opacity = normalizeOpacity(value);
  elements.opacity.value = String(opacity);
  elements.opacityValue.textContent = `${opacity}%`;
  void invoke("set_window_opacity", { opacity }).catch(() => {});
  if (persist) {
    try { localStorage.setItem(OPACITY_STORAGE_KEY, String(opacity)); } catch { /* storage unavailable */ }
  }
}

function applyDisplayMode(compact, persist = true) {
  const enabled = Boolean(compact);
  document.body.dataset.mode = enabled ? "compact" : "";
  elements.miniContent.hidden = !enabled;
  if (enabled) {
    setSettingsView(false);
  }
  void invoke("set_widget_mode", { minimal: enabled }).catch(() => {});
  if (persist) {
    try { localStorage.setItem(MODE_STORAGE_KEY, enabled ? "compact" : "full"); } catch { /* storage unavailable */ }
  }
}

function setSettingsView(open) {
  settingsViewOpen = Boolean(open);
  elements.settingsPanel.hidden = !settingsViewOpen;
  elements.settings.setAttribute("aria-expanded", String(settingsViewOpen));
  if (!settingsViewOpen) syncMainWindowHeight();
}

try { applyOpacity(localStorage.getItem(OPACITY_STORAGE_KEY) || 100, false); } catch { applyOpacity(100, false); }
try { applyDisplayMode(localStorage.getItem(MODE_STORAGE_KEY) === "compact", false); } catch { applyDisplayMode(false, false); }
applyCreditVisibility(creditVisibility, false);

function timezoneLabel() {
  const minutes = -new Date().getTimezoneOffset();
  const hours = Math.floor(Math.abs(minutes) / 60);
  const extraMinutes = Math.abs(minutes) % 60;
  return `UTC${minutes >= 0 ? "+" : "-"}${hours}${extraMinutes ? `:${String(extraMinutes).padStart(2, "0")}` : ""}`;
}

function formatTime(unixSeconds, includeDate = false) {
  const date = new Date(unixSeconds * 1000);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return includeDate ? `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")} ${time}` : time;
}

function formatCountdown(unixSeconds) {
  const seconds = Math.max(0, Math.floor(unixSeconds - Date.now() / 1000));
  if (seconds === 0) return "等待服务刷新额度";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`;
}

function formatMiniCountdown(unixSeconds) {
  const seconds = Math.max(0, Math.floor(unixSeconds - Date.now() / 1000));
  if (seconds === 0) return "等待刷新";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `余 ${hours}h ${minutes}m` : `余 ${minutes}m`;
}

function quotaRemaining(quota) {
  if (!quota || typeof quota.used_percent !== "number" || !Number.isFinite(quota.used_percent)
    || quota.used_percent < 0 || quota.used_percent > 100
    || typeof quota.resets_at !== "number" || !Number.isFinite(quota.resets_at) || quota.resets_at <= 0) return null;
  return 100 - quota.used_percent;
}

function setHalo(ring, progress, value, remaining, state = "ready") {
  ring.dataset.status = state === "loading" ? "loading" : remaining === null ? "unavailable" : remaining <= 10 ? "low" : "ready";
  if (remaining === null) {
    ring.removeAttribute("aria-valuenow");
    ring.setAttribute("aria-valuetext", state === "loading" ? "正在读取" : state === "timeout" ? "读取超时" : "不可用");
  } else {
    ring.setAttribute("aria-valuenow", String(Math.round(remaining)));
    ring.setAttribute("aria-valuetext", `${Math.round(remaining)}% 剩余${state === "timeout" ? "，读取超时" : ""}`);
  }
  progress.style.strokeDashoffset = String(remaining === null ? 100 : 100 - remaining);
  value.textContent = remaining === null ? "—" : `${Math.round(remaining)}%`;
}

function setPrimaryWindow(quota, state = "ready") {
  const remaining = quotaRemaining(quota);
  setHalo(elements.primaryRing, elements.primaryProgress, elements.primaryRemaining, remaining, state);
  setHalo(elements.miniRing, elements.miniProgress, elements.miniRemaining, remaining, state);
  elements.primaryCountdown.textContent = state === "loading" ? "正在读取" : state === "timeout" ? "读取超时，请稍后重试" : remaining === null ? "额度暂不可用" : formatCountdown(quota.resets_at);
  elements.miniCountdown.textContent = state === "loading" ? "正在读取" : state === "timeout" ? "读取超时" : remaining === null ? "不可用" : formatMiniCountdown(quota.resets_at);
  elements.primaryReset.textContent = remaining === null ? "—" : `${formatTime(quota.resets_at)} 重置`;
  elements.miniReset.textContent = elements.primaryReset.textContent;
}

function setWeeklyWindow(quota, state = "ready") {
  const remaining = quotaRemaining(quota);
  elements.weeklyRemaining.textContent = remaining === null ? "—" : `${Math.round(remaining)}%`;
  elements.weeklyProgress.style.width = `${remaining ?? 0}%`;
  elements.weeklyProgress.parentElement.setAttribute("aria-label", state === "loading" ? "每周额度正在读取" : state === "timeout" ? "每周额度读取超时" : remaining === null ? "每周额度不可用" : `每周额度剩余 ${Math.round(remaining)}%`);
  elements.weeklyReset.textContent = state === "loading" ? "正在读取" : state === "timeout" ? "读取超时，显示上次数据" : remaining === null ? "服务未返回每周额度" : `${formatTime(quota.resets_at, true)} 重置`;
  elements.weeklyProgress.closest(".weekly-card").dataset.status = state === "loading" ? "loading" : remaining === null ? "unavailable" : remaining <= 10 ? "low" : "ready";
}

function render() {
  if (!snapshot) return;
  const loading = snapshot.status === "loading";
  const failed = snapshot.status === "unavailable";
  const timedOut = failed && /超时/.test(snapshot.message || "");
  const hasSuccessfulSnapshot = Boolean(lastSuccessfulSnapshot?.primary || lastSuccessfulSnapshot?.weekly);
  elements.quotaContent.hidden = failed && !timedOut;
  elements.errorContent.hidden = !failed || timedOut;
  if (loading) {
    const state = hasSuccessfulSnapshot ? "ready" : "loading";
    setPrimaryWindow(lastSuccessfulSnapshot?.primary || null, state);
    setWeeklyWindow(lastSuccessfulSnapshot?.weekly || null, state);
  } else if (timedOut) {
    setPrimaryWindow(lastSuccessfulSnapshot?.primary || null, "timeout");
    setWeeklyWindow(lastSuccessfulSnapshot?.weekly || null, "timeout");
  } else if (failed) {
    elements.errorMessage.textContent = snapshot.message || "无法读取 Codex 额度。";
    setPrimaryWindow(null);
  } else {
    setPrimaryWindow(snapshot.primary);
    setWeeklyWindow(snapshot.weekly);
  }
  renderUpdatedAt();
}

function renderCredit(name) {
  const view = elements.credits[name];
  const data = creditSnapshots[name];
  if (!view || !data) return;
  const ready = data.status === "ready" && (data.unlimited || (typeof data.remaining === "number" && Number.isFinite(data.remaining) && data.remaining >= 0));
  const remaining = data.remaining;
  const total = data.total;
  const low = ready && !data.unlimited && typeof total === "number" && Number.isFinite(total) && total > 0 && remaining / total <= 0.1;
  view.row.dataset.status = low ? "low" : ready ? "ready" : "unavailable";
  view.value.textContent = !ready ? "—" : data.unlimited ? "不限量" : `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(remaining)} 积分`;
  view.detail.hidden = ready;
  view.detail.textContent = ready ? "" : data.message || "暂时无法读取";
  view.row.title = ready ? "" : view.detail.textContent;
  renderCreditVisibility(name);
  renderUpdatedAt();
}

function isUnloggedCredit(data) {
  return data?.status === "unavailable" && /请(?:登录|连接)|尚未连接|未连接/.test(data.message || "");
}

function renderCreditVisibility(name) {
  const view = elements.credits[name];
  if (!view) return;
  const visible = creditVisibility[name] && (creditVisibility.showUnlogged || !isUnloggedCredit(creditSnapshots[name]));
  view.row.hidden = !visible;
  const hasVisibleCredit = Object.values(elements.credits).some(({ row }) => !row.hidden);
  elements.creditsContent.hidden = !hasVisibleCredit;
  syncMainWindowHeight();
}

function syncMainWindowHeight() {
  if (document.body.dataset.mode === "compact" || settingsViewOpen) return;
  const primaryContent = elements.quotaContent.hidden ? elements.errorContent : elements.quotaContent;
  const height = (elements.panelHeader?.offsetHeight || 57)
    + (primaryContent?.offsetHeight || 250)
    + (elements.creditsContent?.hidden ? 0 : elements.creditsContent?.offsetHeight || 0)
    + (elements.panelFooter?.offsetHeight || 42) + 3;
  const width = document.documentElement?.clientWidth || window.innerWidth || 290;
  void invoke("set_main_window_size", { width, height });
}

function renderUpdatedAt() {
  const latest = Math.max(snapshot?.updated_at || 0, ...Object.values(creditSnapshots).map((item) => item.updated_at || 0));
  elements.updatedAt.textContent = latest ? `更新于 ${formatTime(latest)}` : "尚未更新";
}

async function refreshCredit(name) {
  const requestId = ++creditRequestIds[name];
  const command = name === "workbuddy" ? "refresh_workbuddy" : name === "qoder" ? "refresh_qoder" : "refresh_trae";
  creditSnapshots[name] = { status: "loading", message: "正在读取" };
  renderCredit(name);
  try {
    const result = await invoke(command);
    if (requestId !== creditRequestIds[name]) return;
    creditSnapshots[name] = result;
  } catch {
    if (requestId !== creditRequestIds[name]) return;
    creditSnapshots[name] = { status: "unavailable", message: "读取失败，请稍后重试" };
  }
  renderCredit(name);
  if (name !== "workbuddy") void renderConnectionStatus();
}

async function renderConnectionStatus() {
  try {
    const status = await invoke("connection_status");
    const qoderExpired = /过期|无效/.test(creditSnapshots.qoder?.message || "");
    const traeExpired = /过期|重新登录/.test(creditSnapshots.trae?.message || "");
    elements.qoderConnection.textContent = status.qoder ? qoderExpired ? "需重新连接" : "已连接" : "未连接";
    elements.traeConnection.textContent = status.trae ? traeExpired ? "需重新登录" : "已连接" : "未连接";
    elements.forgetQoder.hidden = !status.qoder;
    elements.forgetTrae.hidden = !status.trae;
  } catch {
    elements.connectionMessages.qoder.textContent = "无法读取连接状态";
    elements.connectionMessages.trae.textContent = "无法读取连接状态";
  }
}

async function connectService(command, args, input, name) {
  const key = name.toLowerCase();
  const message = elements.connectionMessages[key];
  const button = key === "qoder" ? elements.saveQoder : elements.saveTrae;
  const secret = input.value.trim();
  if (!secret) {
    message.textContent = `请先填写 ${name} 凭据`;
    return;
  }
  button.disabled = true;
  message.textContent = `正在连接 ${name}…`;
  try {
    await invoke(command, args(secret));
    input.value = "";
    message.textContent = `${name} 已连接，重新打开软件仍会保持登录`;
    await renderConnectionStatus();
    void refreshCredit(key);
  } catch (error) {
    message.textContent = typeof error === "string" ? error : `${name} 连接失败`;
  } finally {
    button.disabled = false;
  }
}

async function forgetService(command, name) {
  const message = elements.connectionMessages[name];
  const button = name === "qoder" ? elements.forgetQoder : elements.forgetTrae;
  button.disabled = true;
  try {
    await invoke(command);
    creditRequestIds[name]++;
    creditSnapshots[name] = { status: "unavailable", message: "尚未连接" };
    renderCredit(name);
    message.textContent = `${name === "qoder" ? "Qoder" : "TRAE"} 登录已清除`;
    await renderConnectionStatus();
  } catch {
    message.textContent = "无法清除登录信息";
  } finally {
    button.disabled = false;
  }
}

async function refreshCredits() {
  await Promise.all(["workbuddy", "trae", "qoder"].map(refreshCredit));
}

async function refreshCodex() {
  const requestId = ++codexRequestId;
  snapshot = { status: "loading", updated_at: null };
  render();
  let deadline;
  try {
    const result = await Promise.race([
      invoke("refresh_quota"),
      new Promise((resolve) => {
        deadline = setTimeout(
          () => resolve({
            status: "unavailable",
            message: "读取本地 Codex 服务超时（50 秒），请稍后重试。",
            updated_at: null,
          }),
          REFRESH_DEADLINE_MS,
        );
      }),
    ]);
    if (requestId === codexRequestId) {
      snapshot = result;
      if (result.status !== "unavailable") lastSuccessfulSnapshot = result;
    }
  } catch {
    if (requestId === codexRequestId) snapshot = { status: "unavailable", message: "额度工具发生意外错误。", updated_at: null };
  } finally {
    clearTimeout(deadline);
    if (requestId === codexRequestId) render();
  }
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  elements.refresh.disabled = true;
  elements.refresh.setAttribute("aria-busy", "true");
  elements.refresh.classList.add("is-loading");
  try {
    await Promise.all([refreshCodex(), refreshCredits()]);
  } finally {
    refreshing = false;
    elements.refresh.disabled = false;
    elements.refresh.removeAttribute("aria-busy");
    elements.refresh.classList.remove("is-loading");
  }
}

function updateTimezone() {
  elements.timezone.textContent = timezoneLabel();
}

updateTimezone();
setInterval(updateTimezone, 60_000);
window.addEventListener("focus", updateTimezone);
elements.refresh.addEventListener("click", refresh);
elements.settings.addEventListener("click", () => {
  setSettingsView(!settingsViewOpen);
});
elements.settingsBack.addEventListener("click", () => setSettingsView(false));
elements.opacity.addEventListener("input", (event) => applyOpacity(event.target.value));
elements.showUnloggedCredits.addEventListener("change", () => applyCreditVisibility({ ...creditVisibility, showUnlogged: elements.showUnloggedCredits.checked }));
Object.entries(elements.creditVisibility).forEach(([name, checkbox]) => {
  checkbox.addEventListener("change", () => applyCreditVisibility({ ...creditVisibility, [name]: checkbox.checked }));
});
elements.saveQoder.addEventListener("click", () => { void connectService("connect_qoder", (pat) => ({ pat }), elements.qoderToken, "Qoder"); });
elements.saveTrae.addEventListener("click", () => { void connectService("save_trae_token", (token) => ({ token }), elements.traeSecret, "TRAE"); });
elements.loginTrae.addEventListener("click", async () => {
  elements.loginTrae.disabled = true;
  elements.connectionMessages.trae.textContent = "请在 TRAE 登录窗口完成登录";
  try { await invoke("open_trae_login"); }
  catch { elements.connectionMessages.trae.textContent = "无法打开 TRAE 登录窗口"; }
  finally { elements.loginTrae.disabled = false; }
});
elements.forgetQoder.addEventListener("click", () => { void forgetService("forget_qoder", "qoder"); });
elements.forgetTrae.addEventListener("click", () => { void forgetService("forget_trae", "trae"); });
elements.compactToggle.addEventListener("click", () => applyDisplayMode(true));
elements.exitCompact.addEventListener("click", () => applyDisplayMode(false));
elements.minimize.addEventListener("click", () => {
  void invoke("hide_panel");
});
elements.closePanel.addEventListener("click", () => { void invoke("quit_app"); });
elements.miniClosePanel.addEventListener("click", () => { void invoke("quit_app"); });
document.querySelectorAll(".theme-choice").forEach((choice) => {
  choice.addEventListener("click", () => {
    applyTheme(choice.dataset.theme);
  });
});
elements.openUsage.addEventListener("click", async () => {
  try {
    await invoke("open_usage_page");
  } catch {
    elements.errorMessage.textContent = "无法打开 ChatGPT 用量页面，请检查系统默认浏览器设置。";
  }
});
document.querySelector(".panel").addEventListener("mousedown", (event) => {
  if (event.button !== 0 || !(event.target instanceof Element)) return;
  if (event.target.closest("button, a, input, textarea, select")) return;
  void appWindow.startDragging().catch(() => {});
});
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (settingsViewOpen) {
    setSettingsView(false);
  } else {
    void invoke("hide_panel");
  }
});

await listen("quota-refresh-request", refresh);
await listen("trae-auth-complete", () => {
  elements.connectionMessages.trae.textContent = "TRAE 已登录，重新打开软件仍会保持登录";
  void renderConnectionStatus();
  void refreshCredit("trae");
});
setInterval(() => {
  if (snapshot?.primary) render();
}, 1000);
setInterval(() => { void refreshCodex(); }, AUTO_REFRESH_INTERVAL_MS);
setInterval(() => { void refreshCredits(); }, CREDIT_REFRESH_INTERVAL_MS);
void renderConnectionStatus();
refresh();
