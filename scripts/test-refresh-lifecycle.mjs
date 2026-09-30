import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

class FakeElement {
  constructor() {
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.style = { setProperty: (name, value) => { this.style[name] = value; } };
    this.dataset = {};
    this.parentElement = this;
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

  closest() {
    return this;
  }
}

async function runScenario(name, invoke, fireDeadline = false, verifyRefreshRetention = false) {
  const selectors = [
    "#timezone",
    "#quota-content",
    "#error-content",
    "#error-message",
    "#primary-ring",
    "#primary-reset",
    "#primary-remaining",
    "#primary-progress",
    "#primary-countdown",
    "#weekly-remaining",
    "#weekly-progress",
    "#weekly-reset",
    "#mini-content",
    "#mini-ring",
    "#mini-remaining",
    "#mini-ring-progress",
    "#mini-countdown",
    "#mini-reset",
    "#edge-peek",
    "#edge-peek-progress",
    "#exit-compact",
    "#minimize",
    "#close-panel",
    "#mini-close-panel",
    "#updated-at",
    "#refresh",
    "#settings",
    "#settings-back",
    "#theme-options",
    "#compact-toggle",
    "#settings-panel",
    "#credits-content",
    "#show-unlogged-credits",
    "#show-workbuddy-credit",
    "#show-trae-credit",
    "#show-qoder-credit",
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
    "#qoder-message",
    "#trae-message",
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
    ".panel-header",
    ".panel-footer",
  ];
  const elements = new Map(selectors.map((selector) => [selector, new FakeElement()]));
  elements.get("#settings-panel").hidden = true;
  elements.get("#mini-content").hidden = true;
  let deadlineCallback;
  let deadlineMs;
  let quotaCalls = 0;
  let resolveSecondQuota;
  let movedCallback;
  let edgeMoveCallback;
  let edgeLeaveCallback;
  let failTrayExpansion = false;
  const edgeCommands = [];
  const resizeCommands = [];
  const eventListeners = new Map();
  const intervalMs = [];
  const themeChoices = ["violet", "blue", "mint", "amber"].map((theme) => {
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
  globalThis.Element = FakeElement;
  let savedTheme;
  const connected = { qoder: false, trae: false };
  globalThis.localStorage = { getItem: (key) => key === "quota-halo-display-mode" ? "compact" : null, setItem: (_key, value) => { savedTheme = value; } };
  globalThis.window = {
    innerWidth: 290,
    __TAURI__: {
      core: { invoke: (command, args) => command === "set_main_window_size"
        ? (resizeCommands.push({ command, args }), Promise.resolve())
        : command === "connection_status"
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
        : command === "snap_edge_peek"
          ? (edgeCommands.push({ command, args }), Promise.resolve({ direction: "left", width: args.minimal ? 135 : 290, height: args.minimal ? 60 : 515 }))
        : command === "collapse_edge_peek"
          ? (edgeCommands.push({ command, args }), Promise.resolve())
        : command === "expand_edge_peek"
          ? (edgeCommands.push({ command, args }), Promise.resolve())
        : command === "expand_edge_peek_to_full"
          ? (edgeCommands.push({ command, args }), failTrayExpansion ? Promise.reject(new Error("tray expansion failed")) : Promise.resolve())
        : command === "refresh_quota" && verifyRefreshRetention && quotaCalls++ > 0
          ? new Promise((resolve) => { resolveSecondQuota = resolve; })
          : invoke(command, args) },
      event: { listen: async (event, callback) => { eventListeners.set(event, callback); return () => {}; } },
      window: { getCurrentWindow: () => ({ startDragging: async () => {}, onMoved: async (callback) => { movedCallback = callback; } }) },
    },
    addEventListener() {},
  };
  globalThis.setInterval = (_callback, milliseconds) => {
    intervalMs.push(milliseconds);
    return 0;
  };
  globalThis.setTimeout = (callback, milliseconds) => {
    if (milliseconds === 180) {
      edgeMoveCallback = callback;
      return 2;
    }
    if (milliseconds === 350) {
      edgeLeaveCallback = callback;
      return 3;
    }
    deadlineCallback = callback;
    deadlineMs = milliseconds;
    return 1;
  };
  globalThis.clearTimeout = () => {};

  const moduleUrl = `${pathToFileURL(resolve("src/main.js")).href}?test=${name}`;
  await import(moduleUrl);
  await Promise.resolve();
  assert.equal(globalThis.document.body.dataset.mode, "", `${name}: fresh launch should default to full mode`);
  const trayDoubleClick = eventListeners.get("tray-double-click");
  assert.equal(typeof trayDoubleClick, "function", `${name}: tray double click was not observed`);
  const ordinaryDoubleClickCommandCount = edgeCommands.length;
  await trayDoubleClick();
  assert.equal(globalThis.document.body.dataset.mode, "", `${name}: ordinary tray double click changed display mode`);
  assert.equal(edgeCommands.length, ordinaryDoubleClickCommandCount, `${name}: ordinary tray double click invoked an edge command`);
  assert.equal(typeof movedCallback, "function", `${name}: window movement was not observed for edge peek`);
  movedCallback();
  assert.equal(edgeMoveCallback, undefined, `${name}: programmatic startup movement armed edge peek`);
  assert.equal(edgeCommands.length, 0, `${name}: fresh launch entered edge peek`);

  const dragTarget = new FakeElement();
  dragTarget.closest = () => null;
  elements.get(".panel").listeners.get("mousedown")({ button: 0, target: dragTarget });
  movedCallback();
  edgeMoveCallback();
  await Promise.resolve();
  assert.equal(globalThis.document.body.dataset.edgePeek, "left", `${name}: full-mode user drag did not enter edge peek`);
  assert.deepEqual(edgeCommands.at(-1), { command: "snap_edge_peek", args: { minimal: false } }, `${name}: full-mode edge peek lost its source mode`);
  elements.get("#edge-peek").listeners.get("mouseenter")();
  await Promise.resolve();
  assert.equal(globalThis.document.body.dataset.mode, "", `${name}: full-mode edge peek changed display mode`);
  assert.deepEqual(edgeCommands.at(-1), { command: "expand_edge_peek", args: { direction: "left", minimal: false, width: 290, height: 515 } }, `${name}: full-mode edge peek did not restore its original size`);
  elements.get(".panel").listeners.get("mouseleave")();
  edgeLeaveCallback();
  await Promise.resolve();
  assert.deepEqual(edgeCommands.at(-1), { command: "collapse_edge_peek", args: { direction: "left", minimal: false } }, `${name}: full-mode edge peek did not collapse after pointer leave`);
  resizeCommands.length = 0;
  elements.get("#show-workbuddy-credit").checked = false;
  elements.get("#show-workbuddy-credit").listeners.get("change")();
  assert.equal(resizeCommands.length, 0, `${name}: collapsed full edge peek was resized by background content synchronization`);
  failTrayExpansion = true;
  await trayDoubleClick();
  assert.equal(globalThis.document.body.dataset.edgePeek, "left", `${name}: failed tray expansion discarded edge peek state`);
  failTrayExpansion = false;
  await trayDoubleClick();
  await Promise.resolve();
  assert.deepEqual(edgeCommands.at(-1), { command: "expand_edge_peek_to_full", args: { direction: "left", width: 290, height: 515 } }, `${name}: tray double click did not restore the saved full-mode size`);
  assert.equal(globalThis.document.body.dataset.mode, "", `${name}: tray double click did not switch edge peek to full mode`);
  assert.equal(Object.hasOwn(globalThis.document.body.dataset, "edgePeek"), false, `${name}: tray double click left the full-mode window in edge peek`);
  assert.equal(savedTheme, "full", `${name}: tray double click did not persist full mode`);
  elements.get(".panel").listeners.get("mousedown")({ button: 0, target: dragTarget });
  movedCallback();
  edgeMoveCallback();
  await Promise.resolve();
  elements.get("#edge-peek").listeners.get("mouseenter")();
  await Promise.resolve();
  resizeCommands.length = 0;
  elements.get("#show-trae-credit").checked = false;
  elements.get("#show-trae-credit").listeners.get("change")();
  assert.equal(resizeCommands.length, 0, `${name}: expanded full edge peek lost its saved size during background content synchronization`);
  elements.get(".panel").listeners.get("mousedown")({ button: 0, target: dragTarget });
  resizeCommands.length = 0;
  elements.get("#show-qoder-credit").checked = false;
  elements.get("#show-qoder-credit").listeners.get("change")();
  assert.ok(resizeCommands.length > 0, `${name}: leaving edge peek did not restore ordinary full-mode height synchronization`);
  ["#show-workbuddy-credit", "#show-trae-credit", "#show-qoder-credit"].forEach((selector) => {
    elements.get(selector).checked = true;
    elements.get(selector).listeners.get("change")();
  });

  elements.get("#compact-toggle").listeners.get("click")();
  await Promise.resolve();
  assert.equal(globalThis.document.body.dataset.mode, "compact", `${name}: compact mode could not be enabled`);
  edgeMoveCallback = undefined;
  movedCallback();
  assert.equal(edgeMoveCallback, undefined, `${name}: mode resize armed compact edge peek`);
  elements.get(".panel").listeners.get("mousedown")({ button: 0, target: dragTarget });
  movedCallback();
  edgeMoveCallback();
  await Promise.resolve();
  assert.equal(globalThis.document.body.dataset.edgePeek, "left", `${name}: stopped window movement did not enter edge peek`);
  assert.deepEqual(edgeCommands.at(-1), { command: "snap_edge_peek", args: { minimal: true } }, `${name}: compact edge peek lost its source mode`);
  await trayDoubleClick();
  await Promise.resolve();
  assert.deepEqual(edgeCommands.at(-1), { command: "expand_edge_peek_to_full", args: { direction: "left", width: 0, height: 0 } }, `${name}: compact edge peek did not request the default full-mode size`);
  assert.equal(globalThis.document.body.dataset.mode, "", `${name}: compact edge peek tray double click did not switch to full mode`);
  elements.get("#compact-toggle").listeners.get("click")();
  elements.get(".panel").listeners.get("mousedown")({ button: 0, target: dragTarget });
  movedCallback();
  edgeMoveCallback();
  await Promise.resolve();
  elements.get("#edge-peek").listeners.get("mouseenter")();
  await Promise.resolve();
  assert.equal(Object.hasOwn(globalThis.document.body.dataset, "edgePeek"), false, `${name}: hover expansion kept compact content hidden`);
  assert.deepEqual(edgeCommands.at(-1), { command: "expand_edge_peek", args: { direction: "left", minimal: true, width: 135, height: 60 } }, `${name}: compact edge peek did not restore its fixed size`);
  assert.equal(typeof elements.get(".panel").listeners.get("mouseleave"), "function", `${name}: edge peek collapse is not bound to the stable panel boundary`);
  elements.get(".panel").listeners.get("mouseleave")();
  edgeLeaveCallback();
  await Promise.resolve();
  assert.equal(globalThis.document.body.dataset.edgePeek, "left", `${name}: leaving expanded compact mode did not restore edge peek`);
  assert.deepEqual(edgeCommands.slice(-1), [{ command: "collapse_edge_peek", args: { direction: "left", minimal: true } }], `${name}: expanded edge changed direction or re-ran edge detection`);
  let edgeMouseDownStopped = false;
  elements.get("#edge-peek").listeners.get("mousedown")({ stopPropagation: () => { edgeMouseDownStopped = true; } });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(edgeMouseDownStopped, true, `${name}: edge-bar drag bubbled into the panel drag handler`);
  assert.equal(Object.hasOwn(globalThis.document.body.dataset, "edgePeek"), false, `${name}: dragging the edge bar did not restore its source mode`);
  assert.deepEqual(edgeCommands.at(-1), { command: "expand_edge_peek", args: { direction: "left", minimal: true, width: 135, height: 60 } }, `${name}: edge-bar drag expanded with the wrong source mode`);
  movedCallback();
  edgeMoveCallback();
  await Promise.resolve();
  assert.deepEqual(edgeCommands.at(-1), { command: "snap_edge_peek", args: { minimal: true } }, `${name}: edge-bar drag could not re-enter edge peek`);
  elements.get("#exit-compact").listeners.get("click")();
  await Promise.resolve();
  assert.ok(intervalMs.includes(180_000), `${name}: automatic refresh is not three minutes`);
  assert.equal(globalThis.document.body.dataset.theme, "", `${name}: violet should be the default skin`);
  if (verifyRefreshRetention) {
    elements.get("#refresh").listeners.get("click")();
    await Promise.resolve();
    assert.notEqual(elements.get("#primary-countdown").textContent, "正在读取", `${name}: refresh replaced the primary countdown with loading text`);
    assert.notEqual(elements.get("#weekly-reset").textContent, "正在读取", `${name}: refresh replaced the weekly reset with loading text`);
    resolveSecondQuota({
      status: "ready",
      updated_at: Math.floor(Date.now() / 1000),
      primary: { used_percent: 30, window_duration_mins: 300, resets_at: 1_900_000_000 },
      weekly: { used_percent: 45, window_duration_mins: 10_080, resets_at: 1_900_000_000 },
    });
    await new Promise((resolve) => setImmediate(resolve));
  }
  elements.get("#settings").listeners.get("click")();
  assert.equal(elements.get("#settings-panel").hidden, false, `${name}: settings panel did not open`);
  themeChoices.find((choice) => choice.dataset.theme === "blue").listeners.get("click")();
  assert.equal(globalThis.document.body.dataset.theme, "blue", `${name}: selected skin was not applied`);
  assert.equal(savedTheme, "blue", `${name}: selected skin was not saved`);
  elements.get("#settings-back").listeners.get("click")();
  assert.equal(elements.get("#settings-panel").hidden, true, `${name}: settings panel did not close after returning`);
  elements.get("#compact-toggle").listeners.get("click")();
  await Promise.resolve();
  assert.equal(globalThis.document.body.dataset.mode, "compact", `${name}: compact mode was not enabled`);
  assert.equal(Object.hasOwn(globalThis.document.body.dataset, "edgePeek"), false, `${name}: ordinary compact mode was incorrectly marked as edge peek`);
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
  assert.equal(elements.get('[data-service="qoder"]').hidden, true, `${name}: unsigned-in Qoder should be hidden by default`);
  elements.get("#show-unlogged-credits").checked = true;
  elements.get("#show-unlogged-credits").listeners.get("change")();
  assert.equal(elements.get('[data-service="qoder"]').hidden, false, `${name}: unsigned-in Qoder should show when enabled`);
  elements.get("#show-workbuddy-credit").checked = false;
  elements.get("#show-workbuddy-credit").listeners.get("change")();
  assert.equal(elements.get('[data-service="workbuddy"]').hidden, true, `${name}: WorkBuddy should hide when disabled`);
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
  false,
  true,
);

const styles = await readFile(resolve("src/styles.css"), "utf8");
const markup = await readFile(resolve("src/index.html"), "utf8");
assert.match(styles, /\.panel \{[^}]*border-radius:10px/);
assert.match(styles, /\.panel \{[^}]*border:0/);
assert.match(styles, /\.settings-panel \{ position:absolute; inset:0 0 42px/);
assert.match(styles, /\.settings-content:hover::-webkit-scrollbar-thumb \{ background:var\(--soft-border\)/);
assert.match(styles, /\.halo-ring \{[^}]*flex: 0 0 104px/);
assert.match(styles, /\.theme-choice\[data-theme="violet"\] i \{ background:#bc5cff/);
assert.match(markup, /距离重置还剩/);
assert.match(styles, /\.qoder-mark::before \{[^}]*mask:url\("\.\/qoder-color\.svg"\)/);
assert.match(markup, /<img src="\.\/workbuddy\.svg" alt=""/);
assert.match(styles, /\.edge-peek \{[^}]*border-radius:10px/);
assert.match(styles, /\.edge-peek span \{[^}]*border-radius:999px/);

const failed = await runScenario("rpc-error", async () => ({
  status: "unavailable",
  message: "本地 Codex 服务拒绝了 account/rateLimits/read 请求（错误代码 -32603）。",
  updated_at: null,
}));
assert.match(failed.get("#error-message").textContent, /-32603/);

const timedOut = await runScenario("timeout", () => new Promise(() => {}), true);
assert.match(timedOut.get("#primary-countdown").textContent, /读取超时/);
console.log("Refresh lifecycle checks passed for success, retained refresh data, RPC error, three-minute polling, and timeout.");
