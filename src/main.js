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
  updatedAt: document.querySelector("#updated-at"),
  refresh: document.querySelector("#refresh"),
  settings: document.querySelector("#settings"),
  settingsPanel: document.querySelector("#settings-panel"),
  openUsage: document.querySelector("#open-usage"),
};

let snapshot = null;
let refreshing = false;
const AUTO_REFRESH_INTERVAL_MS = 180_000;
const REFRESH_DEADLINE_MS = 50_500;
const THEME_STORAGE_KEY = "quota-halo-skin";
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

function setWindow(target, quota, isWeekly = false) {
  if (!quota) {
    target.remaining.textContent = "未返回";
    target.reset.textContent = "服务未返回该额度窗口";
    if (!isWeekly) {
      if (target.progress) target.progress.style.width = "0%";
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

function render() {
  if (!snapshot) return;
  const failed = snapshot.status === "unavailable";
  elements.quotaContent.hidden = failed;
  elements.errorContent.hidden = !failed;
  if (failed) {
    elements.errorMessage.textContent = snapshot.message || "无法读取 Codex 额度。";
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
  }
  elements.updatedAt.textContent = snapshot.updated_at
    ? `更新于 ${formatTime(snapshot.updated_at)}`
    : "尚未更新";
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  elements.refresh.disabled = true;
  elements.refresh.setAttribute("aria-busy", "true");
  elements.refresh.classList.add("is-loading");
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
    refreshing = false;
    elements.refresh.disabled = false;
    elements.refresh.removeAttribute("aria-busy");
    elements.refresh.classList.remove("is-loading");
    render();
  }
}

elements.timezone.textContent = timezoneLabel();
elements.refresh.addEventListener("click", refresh);
elements.settings.addEventListener("click", () => {
  const open = elements.settingsPanel.hidden;
  elements.settingsPanel.hidden = !open;
  elements.settings.setAttribute("aria-expanded", String(open));
});
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
  if (event.key === "Escape") invoke("hide_panel");
});

await listen("quota-refresh-request", refresh);
setInterval(() => {
  if (snapshot?.primary) render();
}, 1000);
setInterval(refresh, AUTO_REFRESH_INTERVAL_MS);
refresh();
