// Diagnostic probe: only prints protocol status and quota window fields.
// It never logs a raw response, account identifier, or authentication data.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";

const root = join(process.env.LOCALAPPDATA ?? "", "OpenAI", "Codex", "bin");
const candidates = await Promise.all((await readdir(root)).map(async (version) => {
  const path = join(root, version, "codex.exe");
  try { return { path, mtime: (await stat(path)).mtimeMs }; } catch { return null; }
}));
const exe = candidates.filter(Boolean).sort((a, b) => b.mtime - a.mtime)[0]?.path;
if (!exe) throw new Error("Codex CLI not found");

const mode = process.env.QUOTA_HALO_TRANSPORT === "proxy" ? "proxy" : null;
const childEnvironment = { ...process.env };
if (!childEnvironment.HOME && childEnvironment.USERPROFILE) {
  childEnvironment.HOME = childEnvironment.USERPROFILE;
}
if (!childEnvironment.CODEX_HOME && childEnvironment.USERPROFILE) {
  childEnvironment.CODEX_HOME = join(childEnvironment.USERPROFILE, ".codex");
}
const diagnosticCategories = new Set();
const child = spawn(exe, mode ? ["app-server", mode] : ["app-server"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: childEnvironment,
});
child.stderr.on("data", (chunk) => {
  const text = chunk.toString().toLowerCase();
  if (text.includes("could not find home directory")) {
    diagnosticCategories.add("home-unavailable");
  } else if (text.includes("could not create path aliases")) {
    diagnosticCategories.add("path-alias-warning");
  } else if (text.includes("unknown argument") || text.includes("unexpected argument")) {
    diagnosticCategories.add("cli-argument-error");
  } else if (text.includes("permission") || text.includes("denied") || text.includes("access")) {
    diagnosticCategories.add("permission");
  } else if (text.includes("error")) {
    diagnosticCategories.add("cli-error");
  } else {
    diagnosticCategories.add("other");
  }
});
const responses = new Map();
const stdoutSummaries = [];
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  try {
    const value = JSON.parse(line);
    if (typeof value.id === "number") {
      stdoutSummaries.push(
        `response id=${value.id} error=${value.error?.code ?? "none"} result=${value.result !== undefined}`,
      );
    } else if (typeof value.method === "string") {
      stdoutSummaries.push(`notification ${value.method}`);
    }
    const pending = responses.get(value.id);
    if (typeof value.id === "number" && pending) {
      pending.resolve(value);
      responses.delete(value.id);
    }
  } catch {
    stdoutSummaries.push("non-JSON stdout line");
  }
});
child.once("exit", (code) => {
  for (const pending of responses.values()) {
    pending.reject(new Error(`app-server exited before replying (code ${code ?? "unknown"})`));
  }
  responses.clear();
});

function request(id, method, params = {}) {
  return Promise.race([
    new Promise((resolve, reject) => {
      responses.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${method}: timed out`)), 15000)),
  ]);
}

async function timedRequest(id, method, params = {}) {
  const startedAt = performance.now();
  const response = await request(id, method, params);
  console.log(`Protocol timing: ${method} ${Math.round(performance.now() - startedAt)} ms`);
  return response;
}

try {
  const init = await timedRequest(0, "initialize", {
    clientInfo: { name: "quota-halo-diagnostic", version: "0.1.0" }, capabilities: {},
  });
  if (init.error) throw new Error(`initialize failed (code ${init.error.code ?? "unknown"})`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);

  if (process.env.QUOTA_HALO_INCLUDE_ACCOUNT_READ === "1") {
    const account = await timedRequest(1, "account/read", { refreshToken: false });
    if (account.error) throw new Error(`account/read failed (code ${account.error.code ?? "unknown"})`);
    console.log(`Account mode: ${account.result?.account?.type ?? "none"}`);
  }

  let rate;
  for (let attempt = 0; attempt < 3; attempt++) {
    rate = await timedRequest(2 + attempt, "account/rateLimits/read");
    if (!rate.error || rate.error.code !== -32603 || attempt === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  if (rate.error) throw new Error(`account/rateLimits/read failed (code ${rate.error.code ?? "unknown"})`);
  const result = rate.result ?? {};
  console.log(`Top-level fields: ${Object.keys(result).join(", ")}`);
  const items = result.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length
    ? Object.values(result.rateLimitsByLimitId)
    : [result.rateLimits];
  for (const item of items.filter(Boolean)) {
    for (const slot of ["primary", "secondary"]) {
      const window = item[slot];
      if (!window) continue;
      console.log(`${slot}: duration=${window.windowDurationMins ?? "missing"}, used=${window.usedPercent ?? "missing"}, resetsAt=${window.resetsAt ?? "missing"}`);
    }
  }
} catch (error) {
  console.error(error.message);
  if (stdoutSummaries.length) {
    console.error(`App Server protocol summary: ${stdoutSummaries.join("; ")}`);
  } else {
    console.error("App Server protocol summary: no stdout lines");
  }
  if (diagnosticCategories.size) {
    console.error(`CLI diagnostic categories: ${[...diagnosticCategories].join(", ")}`);
  }
  process.exitCode = 1;
} finally {
  child.kill();
}
