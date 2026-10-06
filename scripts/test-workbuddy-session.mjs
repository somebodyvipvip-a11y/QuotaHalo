import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src-tauri/src/workbuddy_session.cjs', import.meta.url), 'utf8');
function run({ loggedOut = false, failOpen = false, scheme, exportName = 'renamedReader' } = {}) {
  const output = [];
  let disposed = false;
  let key;
  const runtime = {
    $() {},
    bootstrap: function bootstrap() {
      const atRestSecretKey = true;
      key = Buffer.alloc(32, 1);
      return {symmetric: { status: atRestSecretKey ? 'available' : 'unavailable', value: { key, keyId: 'fixture' } }};
    },
    parseEnvelope: bytes => bytes,
    [exportName]: class {
      constructor(material) { assert.equal(material.key, key); }
      open() { if (failOpen) throw new Error('sensitive-fixture'); return Buffer.from('fixture-token'); }
      dispose() { disposed = true; }
    },
  };
  const mockedFs = {
    existsSync: () => loggedOut,
    readFileSync: pathname => pathname.endsWith('credential-protection.js')
      ? `crypto=e.key?new t.${exportName}(e.key);let i=t.parseEnvelope(r);return this.requireCrypto().open(i)`
      : JSON.stringify({ auth: { accessToken: { $wbEncrypted: 1, envelope: 'Zml4dHVyZQ==', scheme } }, account: { uid: 'fixture-uid' } }),
  };
  const process = {
    execPath: 'C:/fixture/WorkBuddy.exe', env: { LOCALAPPDATA: 'C:/fixture' },
    _linkedBinding: () => ({ loggerGet: () => '{}' }),
    stdout: { write: value => output.push(value) }, exitCode: 0,
  };
  vm.runInNewContext(source, {
    process, Buffer,
    require: name => name === 'node:fs' ? mockedFs : name === 'node:path' ? path : runtime,
  });
  return { output: output.join(''), exit: process.exitCode, disposed, key };
}
for (const exportName of ['renamedReader', 'nextBundleReader']) {
  const success = run({ exportName });
  assert.deepEqual(JSON.parse(success.output), { token: 'fixture-token', uid: 'fixture-uid' });
  assert.equal(success.exit, 0);
  assert.ok(success.disposed);
  assert.ok(success.key.every(byte => byte === 0));
}
for (const options of [{ loggedOut: true }, { failOpen: true }, { scheme: 'unknown' }]) {
  const failure = run(options);
  assert.equal(failure.exit, 1);
  assert.equal(failure.output, '');
}
console.log('WorkBuddy session checks passed: bundle export discovery, private result, key cleanup, logout and sanitized errors.');
