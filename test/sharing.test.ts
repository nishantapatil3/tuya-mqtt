import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash, webcrypto } from 'node:crypto';
import { SharingLogin, SharingCloud, sharingKeys, encryptSharing, decryptSharing, sharingSign, sessionSchema, type SharingSession } from '../src/sharing.js';
import { configSchema } from '../src/config.js';
import { readFile } from 'node:fs/promises';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { savePrivate } from '../src/storage.js';

function session(expired = false): SharingSession {
  return { clientId: 'test-client', userCode: 'app-user-code', terminalId: 'terminal', endpoint: 'https://apigw.tuyaus.com',
    token: { t: expired ? 1 : Date.now(), uid: 'user', expire_time: 7200, access_token: 'access', refresh_token: 'refresh' } };
}
function envelope(result: unknown, success = true) { return Response.json({ success, result, t: Date.now() }); }
test('QR login uses app user code, waits for approval and returns a validated private session', async () => {
  const calls: URL[] = []; let approved = false;
  const login = new SharingLogin((async (url, options) => {
    calls.push(new URL(String(url)));
    if (options?.method === 'POST') return envelope({ qrcode: 'qr-test' });
    return approved ? envelope({ terminal_id: 'terminal', endpoint: 'https://apigw.tuyaus.com', ...session().token }) : envelope({}, false);
  }) as typeof fetch);
  const qr = await login.start('APP_CODE');
  assert.equal(qr.content, 'tuyaSmart--qrLogin?token=qr-test');
  assert.equal(calls[0]!.searchParams.get('usercode'), 'APP_CODE');
  assert.equal(calls[0]!.searchParams.get('schema'), 'haauthorize');
  assert.equal(await login.check(qr.id), undefined);
  approved = true;
  const saved = await login.check(qr.id);
  assert.equal(saved?.userCode, 'APP_CODE');
  assert.equal(saved?.token.access_token, 'access');
  assert.deepEqual(await login.check(qr.id), saved, 'An approved session can be retried after a lost browser response');
});
test('a replaced QR challenge cannot approve an earlier login', async () => {
  const login = new SharingLogin((async () => envelope({ qrcode: 'qr-test' })) as typeof fetch);
  const first = await login.start('first');
  await login.start('second');
  await assert.rejects(login.check(first.id), /replaced/);
});
test('an approval made before QR expiry can still be claimed after the local deadline', async () => {
  const originalNow = Date.now;
  const start = originalNow();
  const login = new SharingLogin((async (_url, options) => options?.method === 'POST' ? envelope({ qrcode: 'approved-code' }) :
    envelope({ terminal_id: 'terminal', endpoint: 'https://apigw.tuyaus.com', ...session().token })) as typeof fetch);
  const qr = await login.start('TEST_CODE');
  try {
    Date.now = () => start + 181000;
    const result = await login.check(qr.id);
    assert.equal(result?.token.access_token, 'access');
    assert.deepEqual(await login.check(qr.id), result);
  } finally { Date.now = originalNow; }
});
test('an unapproved QR reports expiry only after checking the Tuya response', async () => {
  const originalNow = Date.now;
  const start = originalNow(); let checks = 0;
  const login = new SharingLogin((async (_url, options) => {
    if (options?.method === 'POST') return envelope({ qrcode: 'unapproved-code' });
    checks++; return envelope({}, false);
  }) as typeof fetch);
  const qr = await login.start('TEST_CODE');
  try {
    Date.now = () => start + 181000;
    await assert.rejects(login.check(qr.id), /QR login expired/);
    assert.equal(checks, 1);
  } finally { Date.now = originalNow; }
});
test('QR creation retries one connection failure and still returns a usable code', async () => {
  let attempts = 0;
  const login = new SharingLogin((async () => {
    if (++attempts === 1) throw new TypeError('fetch failed');
    return envelope({ qrcode: 'retried-code' });
  }) as typeof fetch);
  const qr = await login.start('TEST_CODE');
  assert.equal(attempts, 2);
  assert.equal(qr.content, 'tuyaSmart--qrLogin?token=retried-code');
});
test('QR connection retries are bounded and do not retry a rejected user code', async () => {
  let attempts = 0;
  const offline = new SharingLogin((async () => { attempts++; throw new Error('timeout'); }) as typeof fetch);
  await assert.rejects(offline.start('TEST_CODE'), /connection failed or timed out/);
  assert.equal(attempts, 2);
  attempts = 0;
  const rejected = new SharingLogin((async () => { attempts++; return envelope({}, false); }) as typeof fetch);
  await assert.rejects(rejected.start('TEST_CODE'), /Could not create a QR code/);
  assert.equal(attempts, 1);
});
test('sharing endpoint validation prevents sending tokens to arbitrary servers', () => {
  for (const endpoint of ['http://apigw.tuyaus.com', 'https://evil.example', 'https://apigw.tuyaus.com@evil.example', 'https://apigw.tuyaus.com/path'])
    assert.throws(() => sessionSchema.parse({ ...session(), endpoint }));
  for (const endpoint of ['https://apigw.tuyaus.com', 'https://apigw.iotbing.com', 'https://apigw-weaz.iotbing.com'])
    assert.doesNotThrow(() => sessionSchema.parse({ ...session(), endpoint }));
});
test('AES-GCM wire format interoperates with WebCrypto and authenticates ciphertext', async () => {
  const secret = '0123456789abcdef', nonce = Buffer.from('ABCDEFGHIJKL');
  const encoded = encryptSharing('{"devIds":"blind"}', secret, nonce);
  const key = await webcrypto.subtle.importKey('raw', Buffer.from(secret), 'AES-GCM', false, ['decrypt']);
  const bytes = Buffer.from(encoded, 'base64');
  const plain = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, bytes.subarray(12));
  assert.equal(Buffer.from(plain).toString(), '{"devIds":"blind"}');
  bytes[20] = bytes[20]! ^ 1;
  assert.throws(() => decryptSharing(bytes.toString('base64'), secret));
});
test('sharing signature matches the SDK canonical header order and body placement', () => {
  const keys = sharingKeys('request-id', 'refresh');
  assert.equal(keys.hash, createHash('md5').update('request-idrefresh').digest('hex'));
  assert.equal(keys.secret, createHmac('sha256', 'request-id').update(keys.hash).digest('hex').slice(0, 16));
  const headers = { 'X-token': 'access', 'X-time': '123', 'X-sid': '', 'X-requestId': 'request-id', 'X-appKey': 'client' };
  const canonical = 'X-appKey=client||X-requestId=request-id||X-time=123||X-token=accessQUERYBODY';
  assert.equal(sharingSign(keys.hash, headers, 'QUERY', 'BODY'), createHmac('sha256', keys.hash).update(canonical).digest('hex'));
});
test('sharing refreshes tokens once, persists rotation, and sends encrypted device commands', async () => {
  let refreshes = 0, saves = 0; const requests: { path: string; params?: unknown; body?: unknown }[] = [];
  const savedSession = session(true);
  const cloud = new SharingCloud(savedSession, async s => { saves++; assert.equal(s.token.refresh_token, 'new-refresh'); }, (async (url, options) => {
    const address = new URL(String(url)), headers = new Headers(options?.headers);
    const refreshToken = refreshes === 0 ? 'refresh' : 'new-refresh';
    const { hash, secret } = sharingKeys(headers.get('X-requestId')!, refreshToken);
    const query = address.searchParams.get('encdata') ?? '';
    const body = options?.body ? JSON.parse(String(options.body)).encdata : '';
    assert.equal(headers.get('X-sign'), sharingSign(hash, {
      'X-appKey': headers.get('X-appKey')!, 'X-requestId': headers.get('X-requestId')!,
      'X-sid': '', 'X-time': headers.get('X-time')!, 'X-token': headers.get('X-token')!
    }, query, body));
    requests.push({ path: address.pathname,
      params: query ? JSON.parse(decryptSharing(query, secret)) : undefined,
      body: body ? JSON.parse(decryptSharing(body, secret)) : undefined });
    let result: unknown;
    if (address.pathname.includes('/m/token/')) {
      refreshes++; result = { accessToken: 'new-access', refreshToken: 'new-refresh', expireTime: 7200, uid: 'user' };
    } else if (address.pathname.endsWith('/detail')) result = [{ id: 'blind', name: 'Blind', online: true, status: [{ code: 'percent_state', value: 25 }] }];
    else result = true;
    return envelope(encryptSharing(JSON.stringify(result), secret));
  }) as typeof fetch);
  await Promise.all([cloud.device('blind'), cloud.device('blind')]);
  await cloud.command('blind', 'percent_control', 50);
  assert.equal(refreshes, 1); assert.equal(saves, 1);
  assert.deepEqual(requests.at(-1), { path: '/v1.1/m/thing/blind/commands', params: undefined, body: { commands: [{ code: 'percent_control', value: 50 }] } });
  assert.deepEqual(requests[1]!.params, { devIds: 'blind' });
});
test('sharing mode accepts config without developer credentials, while legacy cloud config still works', async () => {
  const sample = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
  assert.equal(configSchema.parse(sample).authMode, 'cloud');
  assert.equal(configSchema.parse({ ...sample, authMode: 'sharing', tuyaCloud: undefined }).tuyaCloud, undefined);
  assert.throws(() => configSchema.parse({ ...sample, authMode: 'cloud', tuyaCloud: undefined }));
});
test('QR sessions persist atomically with private permissions and survive reloading', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tuya-session-'));
  try {
    const path = join(dir, 'sharing-session.json');
    const first = session(); await savePrivate(path, first);
    const rotated = { ...first, token: { ...first.token, refresh_token: 'rotated' } };
    await savePrivate(path, rotated);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(sessionSchema.parse(JSON.parse(await readFile(path, 'utf8'))), rotated);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
