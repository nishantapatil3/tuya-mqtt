import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { get } from 'node:http';
import { Script } from 'node:vm';

test('setup serves a working page and enforces token, host, origin and configuration validation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tuya-mqtt-test-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: { ...process.env, LOG_LEVEL: 'info', TUYA_MQTT_PORT: '0', TUYA_MQTT_HOST: '127.0.0.1', TUYA_MQTT_CONFIG: join(dir, 'config.json') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => { child.kill('SIGTERM'); if (child.exitCode === null) await once(child, 'exit'); await rm(dir, { recursive: true, force: true }); });
  const base = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server startup timed out')), 5000);
    let output = '';
    child.stdout.on('data', data => {
      output += data.toString(); const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    });
    child.once('error', reject);
  });
  const response = await fetch(base);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.ok(!html.includes('__CSRF__'));
  assert.ok(!html.includes('id="ids"'));
  assert.ok(!html.includes("el('ids')"));
  assert.ok(html.includes('Discover devices'));
  assert.doesNotThrow(() => new Script(html.match(/<script>([\s\S]*?)<\/script>/)![1]!));
  const token = html.match(/const token='([a-f0-9]+)'/)![1]!;
  assert.equal((await fetch(base + '/api/status')).status, 403);
  assert.equal((await fetch(base + '/api/qr/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
  const headers = { 'x-setup-token': token, 'content-type': 'application/json', origin: base };
  const status = await fetch(base + '/api/status', { headers });
  assert.deepEqual(await status.json(), { connected: false, devices: [], sharingLinked: false });
  // Manual IDs cannot bypass account discovery or its required account UID.
  const discovery = await fetch(base + '/api/inspect', { method: 'POST', headers,
    body: JSON.stringify({ authMode: 'cloud', tuyaCloud: { region: 'us', accessId: 'test', accessSecret: 'test' }, ids: ['manual-id'] }) });
  assert.equal(discovery.status, 400);
  assert.deepEqual(await discovery.json(), { error: 'Enter your app account UID to discover devices, or connect using a QR code.' });
  assert.equal((await fetch(base + '/api/qr/start', { method: 'POST', headers, body: '{"userCode":""}' })).status, 400);
  assert.equal((await fetch(base + '/api/configure', { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await fetch(base + '/api/configure', { method: 'POST', headers, body: '{}' })).status, 400);
  const badHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    get(base + '/api/status', { headers: { ...headers, host: 'evil.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(badHostStatus, 403);
  const exported = await fetch(base + '/api/mqttthing', { headers });
  assert.deepEqual(await exported.json(), []);
});
