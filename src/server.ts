import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { configSchema, cloudSchema, loadConfig } from './config.js';
import { TuyaCloud } from './cloud.js';
import { TuyaBridge, safeError } from './bridge.js';
import { mqttthing, suggestBlind } from './blind.js';
import { isLocalHost } from './web-access.js';
import { SharingLogin, SharingCloud } from './sharing.js';
import { loadSharing, savePrivate, sharingSessionPath } from './storage.js';
import QRCode from 'qrcode';

const configPath = process.env.TUYA_MQTT_CONFIG ?? './data/config.json';
const port = Number(process.env.TUYA_MQTT_PORT ?? 3200);
const host = process.env.TUYA_MQTT_HOST ?? '127.0.0.1';
let bridge: TuyaBridge | undefined;
let saving = false;
let sharing: SharingCloud | undefined;
const login = new SharingLogin();
let linkedQrId: string | undefined;
let linking: Promise<void> | undefined;
try { sharing = await loadSharing(configPath); } catch { /* A new QR scan can restore an absent or invalid session. */ }
const csrf = randomBytes(24).toString('hex');
async function activate() {
  const config = await loadConfig(configPath);
  if (config.authMode === 'sharing' && !sharing) throw new Error('Connect using a QR code first');
  await bridge?.stop();
  bridge = new TuyaBridge(config, config.authMode === 'sharing' ? sharing : undefined); bridge.start();
}
try { await activate(); }
catch (error) {
  console.log((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Open the setup page to configure your blinds' : 'Configuration could not be loaded; use the setup page to correct it');
}
const html = (await readFile(new URL('./setup.html', import.meta.url), 'utf8')).replace('__CSRF__', csrf);
function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(data));
}
async function input(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
const server = createServer(async (req, res) => {
  try {
    if (!isLocalHost(req.headers.host ?? '')) return send(res, 403, { error: 'Use localhost, a private IP address, or a .local hostname' });
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; img-src 'self' data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'" });
      return res.end(html);
    }
    // All API access requires the page's session token; no cross-origin reads or writes.
    if (req.headers['x-setup-token'] !== csrf) return send(res, 403, { error: 'Reload the setup page' });
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)
      return send(res, 403, { error: 'Invalid origin' });
    if (req.method === 'GET' && req.url === '/api/status') return send(res, 200, { ...(bridge?.status ?? { connected: false, devices: [] }), sharingLinked: Boolean(sharing) });
    if (req.method === 'GET' && req.url === '/api/mqttthing') return send(res, 200, bridge ? mqttthing(bridge.config) : []);
    if (req.method !== 'POST' || !['/api/inspect', '/api/configure', '/api/qr/start', '/api/qr/check'].includes(req.url ?? '')) return send(res, 404, { error: 'Not found' });
    const body = await input(req);
    if (req.url === '/api/qr/start') {
      const qr = await login.start(body.userCode);
      return send(res, 200, { id: qr.id, expiresAt: qr.expiresAt,
        image: await QRCode.toDataURL(qr.content, { errorCorrectionLevel: 'Q', width: 300, margin: 4 }) });
    }
    if (req.url === '/api/qr/check') {
      if (body.id === linkedQrId && sharing) return send(res, 200, { linked: true });
      const session = await login.check(body.id);
      if (!session) return send(res, 200, { linked: false });
      if (!linking) linking = (async () => {
        // Stop the old sharing client before replacing a session with rotated credentials.
        if (bridge?.config.authMode === 'sharing') await bridge.stop();
        await savePrivate(sharingSessionPath(configPath), session);
        sharing = new SharingCloud(session, next => savePrivate(sharingSessionPath(configPath), next));
        linkedQrId = body.id;
        if (bridge?.config.authMode === 'sharing') await activate();
      })().finally(() => { linking = undefined; });
      await linking;
      return send(res, 200, { linked: true });
    }
    if (req.url === '/api/inspect') {
      const config = body.authMode === 'sharing' ? undefined : cloudSchema.parse(body.tuyaCloud);
      const cloud = body.authMode === 'sharing' ? sharing : new TuyaCloud(config!);
      if (!cloud) throw new Error('QR login expired or was replaced. Generate a new code.');
      const ids: string[] = Array.isArray(body.ids) ? body.ids : [];
      if (ids.length > 50 || ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id))) throw new Error('Invalid device IDs');
      const devices = ids.length ? await Promise.all(ids.map(id => cloud.device(id))) : cloud instanceof SharingCloud ? await cloud.devices() : config?.uid ? await cloud.devices(config.uid) : [];
      const result = [];
      for (const device of devices) {
        // Deliberately omit local keys, location, IP addresses and user identifiers.
        const spec = await cloud.specifications(device.id);
        result.push({ id: device.id, name: device.name, category: device.category, online: device.online,
          status: device.status, functions: spec.functions, statusSchema: spec.status,
          suggestedMapping: suggestBlind(device, spec) });
      }
      return send(res, 200, result);
    }
    if (saving) return send(res, 409, { error: 'Another save is in progress' });
    const config = configSchema.parse(body);
    if (config.authMode === 'sharing' && !sharing) throw new Error('QR login expired or was replaced. Generate a new code.');
    saving = true;
    try {
      await savePrivate(configPath, config);
      await activate();
      return send(res, 200, { ok: true });
    } finally { saving = false; }
  } catch (error) {
    if (error && typeof error === 'object' && 'issues' in error)
      return send(res, 400, { error: 'Invalid configuration. Check required fields, region, unique device IDs, and polling intervals.' });
    return send(res, 400, { error: safeError(error) });
  }
});
server.requestTimeout = 30000;
server.listen(port, host, () => console.log(`Tuya MQTT setup: http://${host}:${(server.address() as { port: number }).port}`));
async function shutdown() {
  server.close();
  const deadline = setTimeout(() => process.exit(1), 10000); deadline.unref();
  await bridge?.stop();
  server.closeAllConnections();
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
