const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const appWindow = window.__TAURI__.window.getCurrentWindow();

const elements = {
  timezone: document.querySelector("#timezone"),
  quotaContent: document.querySelector("#quota-content"),
  errorContent: document.querySelector("#error-content"),
  errorMessage: document.querySelector("#error-message"),
  primaryReset: document.querySelector("#primary-reset"),
  primaryRemaining: document.querySelector("#primary-remaining"),
  primaryProgress: document.querySelector("#primary-progress"),
  primaryCountdown: document.querySelector("#primary-countdown"),
  weeklyRemaining: document.querySelector("#weekly-remaining"),
  weeklyProgress: document.querySelector("#weekly-progress"),
  weeklyReset: document.querySelector("#weekly-reset"),
  miniContent: document.querySelector("#mini-content"),
  miniRemaining: document.querySelector("#mini-remaining"),
  miniProgress: document.querySelector("#mini-ring-progress"),
  miniCountdown: document.querySelector("#mini-countdown"),
  miniReset: document.querySelector("#mini-reset"),
  exitCompact: document.querySelector("#exit-compact"),
  updatedAt: document.querySelector("#updated-at"),
  refresh: document.querySelector("#refresh"),
  settings: document.querySelector("#settings"),
  compactToggle: document.querySelector("#compact-toggle"),
  settingsPanel: document.querySelector("#settings-panel"),
  opacity: document.querySelector("#opacity"),
  opacityValue: document.querySelector("#opacity-value"),
  openUsage: document.querySelector("#open-usage"),
  qoderToken: document.querySelector("#qoder-token"),
  traeSecret: document.querySelector("#trae-secret"),
  traeAuthMode: document.querySelector("#trae-auth-mode"),
  saveQoder: document.querySelector("#save-qoder"),
  saveTrae: document.querySelector("#save-trae"),
  credits: Object.fromEntries(["workbuddy", "trae", "qoder"].map((name) => [name, {
    row: document.querySelector(`[data-service="${name}"]`),
    value: document.querySelector(`#${name}-remaining`),
    detail: document.querySelector(`#${name}-detail`),
  }])),
};

let snapshot = null;
let refreshing = false;
const creditSnapshots = {};
const credentials = { qoder: "", trae: "", traeMode: "bearer" };
const creditRequestIds = { workbuddy: 0, trae: 0, qoder: 0 };
const AUTO_REFRESH_INTERVAL_MS = 180_000;
const CREDIT_REFRESH_INTERVAL_MS = 300_000;
const REFRESH_DEADLINE_MS = 50_500;
const THEME_STORAGE_KEY = "quota-halo-skin";
const OPACITY_STORAGE_KEY = "quota-halo-opacity";
const MODE_STORAGE_KEY = "quota-halo-display-mode";
const THEMES = new Set(["violet", "cyan", "indigo", "moss", "amber", "mono"]);

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
  void invoke("set_widget_mode", { minimal: enabled }).catch(() => {});
  if (persist) {
    try { localStorage.setItem(MODE_STORAGE_KEY, enabled ? "compact" : "full"); } catch { /* storage unavailable */ }
  }
}

try { applyOpacity(localStorage.getItem(OPACITY_STORAGE_KEY) || 100, false); } catch { applyOpacity(100, false); }
try { applyDisplayMode(localStorage.getItem(MODE_STORAGE_KEY) === "compact", false); } catch { applyDisplayMode(false, false); }

function timezoneLabel() {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "本地时区";
  if (zone === "Asia/Shanghai") return "北京时间 UTC+8";
  const offset = new Intl.DateTimeFormat("en-US", { timeZoneName: "longOffset" })
    .formatToParts(new Date())
    .find((part) => part.type === "timeZoneName")?.value;
  return `${zone}${offset ? ` ${offset.replace("GMT", "UTC")}` : ""}`;
}

function formatTime(unixSeconds, includeDate = false) {
  const options = includeDate
    ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }
    : { hour: "2-digit", minute: "2-digit", hour12: false };
  return new Intl.DateTimeFormat("zh-CN", options).format(new Date(unixSeconds * 1000));
}

function formatCountdown(unixSeconds) {
  const seconds = Math.max(0, Math.floor(unixSeconds - Date.now() / 1000));
  if (seconds === 0) return "等待服务刷新额度";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `还剩 ${hours} 小时 ${minutes} 分钟` : `还剩 ${minutes} 分钟`;
}

function formatMiniCountdown(unixSeconds) {
  const seconds = Math.max(0, Math.floor(unixSeconds - Date.now() / 1000));
  if (seconds === 0) return "等待服务刷新额度";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `余 ${hours}h ${minutes}m` : `余 ${minutes}m`;
}

function setWindow(target, quota, isWeekly = false) {
  if (!quota) {
    target.remaining.textContent = "未返回";
    target.reset.textContent = "服务未返回该额度窗口";
    if (target.progress) target.progress.style.width = "0%";
    if (!isWeekly) {
      elements.primaryCountdown.textContent = "无法计算倒计时";
    }
    return;
  }
  const remaining = Math.max(0, Math.min(100, 100 - quota.used_percent));
  target.remaining.textContent = `剩余 ${Math.round(remaining)}%`;
  if (target.progress) target.progress.style.width = `${remaining}%`;
  target.reset.textContent = isWeekly
    ? `重置于 ${formatTime(quota.resets_at, true)}`
    : `${formatTime(quota.resets_at)} 重置`;
  if (!isWeekly) {
    elements.primaryCountdown.textContent = formatCountdown(quota.resets_at);
  }
}

function setMiniWindow(quota) {
  if (!quota) {
    elements.miniRemaining.textContent = "—";
    elements.miniProgress.style.strokeDashoffset = "100";
    elements.miniCountdown.textContent = "服务未返回 5 小时额度";
    elements.miniReset.textContent = "—";
    return;
  }
  const remaining = Math.max(0, Math.min(100, 100 - quota.used_percent));
  elements.miniRemaining.textContent = `${Math.round(remaining)}%`;
  elements.miniProgress.style.strokeDashoffset = String(100 - remaining);
  elements.miniCountdown.textContent = formatMiniCountdown(quota.resets_at);
  elements.miniReset.textContent = `${formatTime(quota.resets_at)} 重置`;
}

function render() {
  if (!snapshot) return;
  const failed = snapshot.status === "unavailable";
  elements.quotaContent.hidden = failed;
  elements.errorContent.hidden = !failed;
  if (failed) {
    elements.errorMessage.textContent = snapshot.message || "无法读取 Codex 额度。";
    setMiniWindow(null);
    elements.miniCountdown.textContent = "Codex 暂时不可用";
  } else {
    setWindow(
      { remaining: elements.primaryRemaining, reset: elements.primaryReset, progress: elements.primaryProgress },
      snapshot.primary,
    );
    setWindow(
      { remaining: elements.weeklyRemaining, reset: elements.weeklyReset, progress: elements.weeklyProgress },
      snapshot.weekly,
      true,
    );
    setMiniWindow(snapshot.primary);
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
  view.detail.textContent = ready
    ? data.unlimited ? "企业额度" : data.updated_at ? `更新于 ${formatTime(data.updated_at)}` : "已更新"
    : data.message || "暂时无法读取";
  view.row.title = view.detail.textContent;
  renderUpdatedAt();
}

function renderUpdatedAt() {
  const latest = Math.max(snapshot?.updated_at || 0, ...Object.values(creditSnapshots).map((item) => item.updated_at || 0));
  elements.updatedAt.textContent = latest ? `更新于 ${formatTime(latest)}` : "尚未更新";
}

async function refreshCredit(name) {
  const requestId = ++creditRequestIds[name];
  let command;
  let args;
  if (name === "workbuddy") command = "refresh_workbuddy";
  else if (name === "qoder") {
    if (!credentials.qoder) {
      creditSnapshots.qoder = { status: "unavailable", message: "请在设置中配置凭证" };
      renderCredit(name);
      return;
    }
    command = "refresh_qoder";
    args = { token: credentials.qoder };
  } else {
    if (!credentials.trae) {
      creditSnapshots.trae = { status: "unavailable", message: "请在设置中配置凭证" };
      renderCredit(name);
      return;
    }
    command = "refresh_trae";
    args = { secret: credentials.trae, authMode: credentials.traeMode };
  }
  creditSnapshots[name] = { status: "loading", message: "正在读取" };
  renderCredit(name);
  try {
    const result = await invoke(command, args);
    if (requestId !== creditRequestIds[name]) return;
    creditSnapshots[name] = result;
  } catch {
    if (requestId !== creditRequestIds[name]) return;
    creditSnapshots[name] = { status: "unavailable", message: "读取失败，请稍后重试" };
  }
  renderCredit(name);
}

async function refreshCredits() {
  await Promise.all(["workbuddy", "trae", "qoder"].map(refreshCredit));
}

async function refreshCodex() {
  let deadline;
  try {
    snapshot = await Promise.race([
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
  } catch {
    snapshot = { status: "unavailable", message: "额度工具发生意外错误。", updated_at: null };
  } finally {
    clearTimeout(deadline);
    render();
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

elements.timezone.textContent = timezoneLabel();
elements.refresh.addEventListener("click", refresh);
elements.settings.addEventListener("click", () => {
  const open = elements.settingsPanel.hidden;
  elements.settingsPanel.hidden = !open;
  elements.settings.setAttribute("aria-expanded", String(open));
});
elements.opacity.addEventListener("input", (event) => applyOpacity(event.target.value));
elements.saveQoder.addEventListener("click", () => {
  credentials.qoder = elements.qoderToken.value.trim();
  elements.qoderToken.value = "";
  void refreshCredit("qoder");
});
elements.saveTrae.addEventListener("click", () => {
  credentials.trae = elements.traeSecret.value.trim();
  credentials.traeMode = elements.traeAuthMode.value;
  elements.traeSecret.value = "";
  void refreshCredit("trae");
});
elements.compactToggle.addEventListener("click", () => applyDisplayMode(true));
elements.exitCompact.addEventListener("click", () => applyDisplayMode(false));
document.querySelectorAll(".theme-choice").forEach((choice) => {
  choice.addEventListener("click", () => {
    applyTheme(choice.dataset.theme);
    elements.settingsPanel.hidden = true;
    elements.settings.setAttribute("aria-expanded", "false");
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
  if (!elements.settingsPanel.hidden) {
    elements.settingsPanel.hidden = true;
    elements.settings.setAttribute("aria-expanded", "false");
  } else {
    void invoke("hide_panel");
  }
});

await listen("quota-refresh-request", refresh);
setInterval(() => {
  if (snapshot?.primary) render();
}, 1000);
setInterval(() => { void refreshCodex(); }, AUTO_REFRESH_INTERVAL_MS);
setInterval(() => { void refreshCredits(); }, CREDIT_REFRESH_INTERVAL_MS);
refresh();
