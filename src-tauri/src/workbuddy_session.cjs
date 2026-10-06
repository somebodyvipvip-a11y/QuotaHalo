// Runs only in the installed WorkBuddy executable with ELECTRON_RUN_AS_NODE=1.
// stdout is a private pipe to the Rust parent, never a diagnostic log.
try {
  const fs = require('node:fs');
  const path = require('node:path');
  const app = path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'main');
  const storage = process._linkedBinding('electron_browser_workbuddy_storage');
  const source = fs.readFileSync(path.join(app, 'credential-protection.js'), 'utf8');
  // Resolve the current bundle's export names instead of pinning minified names/version.
  const constructor = source.match(/crypto=\w+\.key\?new \w+\.([\w$]+)\(\w+\.key\)/)?.[1];
  const parser = source.match(/let \w+=\w+\.([\w$]+)\(\w+\);return this\.requireCrypto\(\)\.open/)?.[1];
  const runtime = require(path.join(app, 'process-cpu-sampler.js'));
  runtime.$();
  if (!constructor || !parser || typeof runtime[constructor] !== 'function' || typeof runtime[parser] !== 'function') throw new Error();
  const bootstrap = Object.values(runtime).find(value => typeof value === 'function' && /atRestSecretKey/.test(value.toString()) && /return\s*\{\s*symmetric:/.test(value.toString()));
  if (!bootstrap) throw new Error();
  const material = bootstrap(storage.loggerGet()).symmetric;
  if (material?.status !== 'available') throw new Error();
  const key = material.value.key;
  const sessionPath = path.join(process.env.LOCALAPPDATA, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info');
  if (fs.existsSync(sessionPath + '.logged-out')) throw new Error();
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  const encrypted = session.auth?.accessToken;
  if (encrypted?.$wbEncrypted !== 1 || encrypted.scheme || typeof encrypted.envelope !== 'string') throw new Error();
  const reader = new runtime[constructor](material.value);
  try {
    const token = reader.open(runtime[parser](Buffer.from(encrypted.envelope, 'base64')), { framing: 'field' }).toString('utf8');
    if (!token || fs.existsSync(sessionPath + '.logged-out')) throw new Error();
    process.stdout.write(JSON.stringify({ token, uid: session.account?.uid, enterprise_id: session.account?.enterpriseId }));
  } finally {
    reader.dispose();
    key.fill(0);
  }
} catch {
  // Do not forward native errors: they may contain secret material.
  process.exitCode = 1;
}
