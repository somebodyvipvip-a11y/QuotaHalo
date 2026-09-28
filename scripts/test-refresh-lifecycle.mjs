import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

class FakeElement {
  constructor() {
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.style = {};
    this.dataset = {};
    this.attributes = new Set();
    this.listeners = new Map();
    this.classes = new Set();
    this.classList = {
      add: (value) => this.classes.add(value),
      remove: (value) => this.classes.delete(value),
      toggle: (value, force) => {
        if (force) this.classes.add(value);
        else this.classes.delete(value);
      },
    };
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  setAttribute(name) {
    this.attributes.add(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }
}

async function runScenario(name, invoke, fireDeadline = false) {
  const selectors = [
    "#timezone",
    "#quota-content",
    "#error-content",
    "#error-message",
    "#primary-reset",
    "#primary-remaining",
    "#primary-progress",
    "#primary-countdown",
    "#weekly-remaining",
    "#weekly-progress",
    "#weekly-reset",
    "#mini-content",
    "#mini-remaining",
    "#mini-ring-progress",
    "#mini-countdown",
    "#mini-reset",
    "#exit-compact",
    "#updated-at",
    "#refresh",
    "#settings",
    "#compact-toggle",
    "#settings-panel",
    "#opacity",
    "#opacity-value",
    "#open-usage",
    "#qoder-token",
    "#trae-secret",
    "#save-qoder",
    "#save-trae",
    "#login-trae",
    "#forget-qoder",
    "#forget-trae",
    "#qoder-connection",
    "#trae-connection",
    "#connection-message",
    "#workbuddy-remaining",
    "#workbuddy-detail",
    "#trae-remaining",
    "#trae-detail",
    "#qoder-remaining",
    "#qoder-detail",
    '[data-service="workbuddy"]',
    '[data-service="trae"]',
    '[data-service="qoder"]',
    ".panel",
  ];
  const elements = new Map(selectors.map((selector) => [selector, new FakeElement()]));
  elements.get("#settings-panel").hidden = true;
  elements.get("#mini-content").hidden = true;
  let deadlineCallback;
  let deadlineMs;
  const intervalMs = [];
  const themeChoices = ["violet", "cyan", "indigo", "moss", "amber", "mono"].map((theme) => {
    const choice = new FakeElement();
    choice.dataset.theme = theme;
    return choice;
  });
  globalThis.document = {
    body: { dataset: {} },
    querySelector: (selector) => elements.get(selector),
    querySelectorAll: (selector) => {
      if (selector === ".theme-choice") return themeChoices;
      return [];
    },
  };
  let savedTheme;
  const connected = { qoder: false, trae: false };
  globalThis.localStorage = { getItem: () => null, setItem: (_key, value) => { savedTheme = value; } };
  globalThis.window = {
    __TAURI__: {
      core: { invoke: (command, args) => command === "connection_status"
        ? Promise.resolve({ ...connected })
        : command === "connect_qoder"
          ? (connected.qoder = true, Promise.resolve())
          : command === "save_trae_token"
            ? (connected.trae = true, Promise.resolve())
            : command === "forget_qoder"
              ? (connected.qoder = false, Promise.resolve())
              : command === "forget_trae"
                ? (connected.trae = false, Promise.resolve())
                : command === "refresh_workbuddy"
        ? Promise.resolve({ status: "ready", remaining: 2450.5, total: 3000, updated_at: 1_900_000_000 })
        : command === "refresh_qoder"
          ? Promise.resolve(connected.qoder ? { status: "ready", remaining: 1280, total: 2000, updated_at: 1_900_000_000 } : { status: "unavailable", message: "请连接 Qoder 账号" })
          : command === "refresh_trae"
            ? Promise.resolve(connected.trae ? { status: "ready", remaining: 860, total: 1000, updated_at: 1_900_000_000 } : { status: "unavailable", message: "请登录 TRAE 账号" })
        : invoke(command, args) },
      event: { listen: async () => {} },
      window: { getCurrentWindow: () => ({ startDragging: async () => {} }) },
    },
    addEventListener() {},
  };
  globalThis.setInterval = (_callback, milliseconds) => {
    intervalMs.push(milliseconds);
    return 0;
  };
  globalThis.setTimeout = (callback, milliseconds) => {
    deadlineCallback = callback;
    deadlineMs = milliseconds;
    return 1;
  };
  globalThis.clearTimeout = () => {};

  const moduleUrl = `${pathToFileURL(resolve("src/main.js")).href}?test=${name}`;
  await import(moduleUrl);
  await Promise.resolve();
  assert.ok(intervalMs.includes(180_000), `${name}: automatic refresh is not three minutes`);
  assert.equal(globalThis.document.body.dataset.theme, "", `${name}: violet should be the default skin`);
  elements.get("#settings").listeners.get("click")();
  assert.equal(elements.get("#settings-panel").hidden, false, `${name}: settings panel did not open`);
  themeChoices.find((choice) => choice.dataset.theme === "cyan").listeners.get("click")();
  assert.equal(globalThis.document.body.dataset.theme, "cyan", `${name}: selected skin was not applied`);
  assert.equal(savedTheme, "cyan", `${name}: selected skin was not saved`);
  elements.get("#compact-toggle").listeners.get("click")();
  await Promise.resolve();
  assert.equal(globalThis.document.body.dataset.mode, "compact", `${name}: compact mode was not enabled`);
  assert.equal(elements.get("#mini-content").hidden, false, `${name}: compact content was not shown`);
  elements.get("#exit-compact").listeners.get("click")();
  await Promise.resolve();
  assert.equal(globalThis.document.body.dataset.mode, "", `${name}: compact mode was not disabled`);
  if (fireDeadline) {
    assert.equal(deadlineMs, 50_500);
    deadlineCallback();
  }
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  const refresh = elements.get("#refresh");
  assert.equal(refresh.classes.has("is-loading"), false, `${name}: loading class remains`);
  assert.equal(refresh.disabled, false, `${name}: refresh button remains disabled`);
  assert.equal(refresh.attributes.has("aria-busy"), false, `${name}: busy state remains`);
  assert.equal(elements.get("#workbuddy-remaining").textContent, "2,450.5 积分");
  assert.equal(elements.get("#qoder-remaining").textContent, "—");
  elements.get("#qoder-token").value = "pt-test-token";
  elements.get("#save-qoder").listeners.get("click")();
  elements.get("#trae-secret").value = "test-secret";
  elements.get("#save-trae").listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.get("#qoder-token").value, "", `${name}: Qoder credential remained in input`);
  assert.equal(elements.get("#trae-secret").value, "", `${name}: TRAE credential remained in input`);
  assert.equal(elements.get("#qoder-remaining").textContent, "1,280 积分");
  assert.equal(elements.get("#trae-remaining").textContent, "860 积分");
  return elements;
}

await runScenario(
  "success",
  async () => ({
    status: "ready",
    updated_at: Math.floor(Date.now() / 1000),
    primary: { used_percent: 25, window_duration_mins: 300, resets_at: 1_900_000_000 },
    weekly: { used_percent: 40, window_duration_mins: 10_080, resets_at: 1_900_000_000 },
  }),
);

const failed = await runScenario("rpc-error", async () => ({
  status: "unavailable",
  message: "本地 Codex 服务拒绝了 account/rateLimits/read 请求（错误代码 -32603）。",
  updated_at: null,
}));
assert.match(failed.get("#error-message").textContent, /-32603/);

const timedOut = await runScenario("timeout", () => new Promise(() => {}), true);
assert.match(timedOut.get("#error-message").textContent, /50 秒/);
console.log("Refresh lifecycle checks passed for success, RPC error, three-minute polling, and timeout.");
