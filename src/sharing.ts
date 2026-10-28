import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Device, Specification } from './cloud.js';
import { createLogger } from './logger.js';
const logger = createLogger('sharing');

// Protocol reference: Tuya's official tuya-device-sharing-sdk (user.py, customerapi.py).
export const sharingClientId = process.env.TUYA_SHARING_CLIENT_ID ?? 'HA_3y9q4ak7g4ephrvke';
const schema = process.env.TUYA_SHARING_SCHEMA ?? 'haauthorize';
const gateway = 'https://apigw.iotbing.com';
const tokenSchema = z.object({ t: z.number(), uid: z.string(), expire_time: z.number().positive(), access_token: z.string().min(1), refresh_token: z.string().min(1) });
export const sessionSchema = z.object({
  clientId: z.string().min(1), userCode: z.string().min(1), terminalId: z.string().min(1),
  endpoint: z.string().url().refine(value => {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
      /^(apigw(?:-[a-z]+)?\.iotbing\.com|apigw\.tuya(?:us|eu|cn|in)\.com)$/.test(u.hostname) &&
      u.pathname === '/' && !u.search && !u.hash;
  }, 'Unrecognized Tuya sharing endpoint'),
  token: tokenSchema
});
export type SharingSession = z.infer<typeof sessionSchema>;
type Envelope<T> = { success: boolean; result: T; t: number; code?: string | number };
class TuyaConnectionError extends Error {}
async function response<T>(fetcher: typeof fetch, url: string, options: RequestInit): Promise<Envelope<T>> {
  const started = Date.now(), path = new URL(url).pathname;
  logger.debug('request.start', { method: options.method, path });
  let result: Response;
  try { result = await fetcher(url, { ...options, signal: AbortSignal.timeout(15000) }); }
  catch { logger.warn('request.connection_failed', { path, elapsedMs: Date.now() - started }); throw new TuyaConnectionError('Tuya connection failed or timed out. Check your internet connection and try again.'); }
  logger.debug('request.response', { path, status: result.status, elapsedMs: Date.now() - started });
  if (!result.ok) throw new Error(`Tuya HTTP ${result.status}`);
  return await result.json() as Envelope<T>;
}
export class SharingLogin {
  private pending?: { token: string; userCode: string; expires: number; id: string; session?: SharingSession };
  constructor(private fetcher: typeof fetch = fetch) {}
  async start(userCode: string) {
    logger.info('qr.start');
    userCode = z.string().trim().min(1).max(128).parse(userCode);
    const id = randomUUID();
    // A newer attempt supersedes an older in-flight start or poll.
    this.pending = { id, token: '', userCode, expires: Date.now() + 180000 };
    const query = new URLSearchParams({ clientid: sharingClientId, usercode: userCode, schema });
    const url = `${gateway}/v1.0/m/life/home-assistant/qrcode/tokens?${query}`;
    let data: Envelope<{ qrcode: string }>;
    try { data = await response<{ qrcode: string }>(this.fetcher, url, { method: 'POST' }); }
    catch (error) {
      // QR creation can safely retry a lost connection; never apply this to motor commands.
      if (!(error instanceof TuyaConnectionError) || this.pending?.id !== id) throw error;
      logger.warn('qr.retry_connection');
      data = await response<{ qrcode: string }>(this.fetcher, url, { method: 'POST' });
    }
    if (this.pending?.id !== id) throw new Error('QR login was replaced; use the newest code');
    if (!data.success || typeof data.result?.qrcode !== 'string' || !data.result.qrcode) {
      logger.warn('qr.rejected', { code: data.code });
      throw new Error('Could not create a QR code. Check your app User Code and try again.');
    }
    this.pending.token = data.result.qrcode;
    logger.info('qr.ready');
    return { id, content: `tuyaSmart--qrLogin?token=${data.result.qrcode}`, expiresAt: this.pending.expires };
  }
  async check(id: string): Promise<SharingSession | undefined> {
    const pending = this.pending;
    if (!pending || pending.id !== id || !pending.token)
      throw new Error('QR login expired or was replaced. Generate a new code.');
    if (pending.session) return pending.session;
    const query = new URLSearchParams({ clientid: sharingClientId, usercode: pending.userCode });
    const data = await response<Record<string, unknown>>(this.fetcher,
      `${gateway}/v1.0/m/life/home-assistant/qrcode/tokens/${encodeURIComponent(pending.token)}?${query}`, { method: 'GET' });
    if (this.pending?.id !== id) throw new Error('QR login was replaced; use the newest code');
    if (!data.success) {
      logger.debug('qr.awaiting_approval', { code: data.code });
      if (Date.now() >= pending.expires) throw new Error('QR login expired. Generate a new code and scan it in the app.');
      return undefined;
    }
    const info = data.result;
    const session = sessionSchema.parse({ clientId: sharingClientId, userCode: pending.userCode,
      terminalId: info.terminal_id, endpoint: info.endpoint ?? info.end_point,
      token: { t: data.t, uid: info.uid, expire_time: info.expire_time,
        access_token: info.access_token, refresh_token: info.refresh_token } });
    // Cache an approved result so a lost browser response or failed local save can retry safely.
    pending.session = session;
    logger.info('qr.approved');
    return session;
  }
}
export function sharingKeys(requestId: string, refreshToken: string) {
  const hash = createHash('md5').update(requestId + refreshToken).digest('hex');
  const secret = createHmac('sha256', requestId).update(hash).digest('hex').slice(0, 16);
  return { hash, secret };
}
export function encryptSharing(text: string, secret: string, nonce = randomBytes(12)) {
  const cipher = createCipheriv('aes-128-gcm', Buffer.from(secret), nonce);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([nonce, encrypted]).toString('base64');
}
export function decryptSharing(text: string, secret: string) {
  const bytes = Buffer.from(text, 'base64');
  const decipher = createDecipheriv('aes-128-gcm', Buffer.from(secret), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
}
export function sharingSign(hash: string, headers: Record<string, string>, query: string, body: string) {
  const text = ['X-appKey', 'X-requestId', 'X-sid', 'X-time', 'X-token']
    .filter(key => headers[key]).map(key => `${key}=${headers[key]}`).join('||') + query + body;
  return createHmac('sha256', hash).update(text).digest('hex');
}
export class SharingCloud {
  private refreshing?: Promise<void>;
  constructor(private session: SharingSession, private save: (session: SharingSession) => Promise<void>, private fetcher: typeof fetch = fetch) {}
  private async raw<T>(method: string, path: string, params?: Record<string, string>, body?: unknown): Promise<{ result: T; t: number }> {
    const requestId = randomUUID();
    const { hash, secret } = sharingKeys(requestId, this.session.token.refresh_token);
    const query = params ? encryptSharing(JSON.stringify(params), secret) : '';
    const encryptedBody = body === undefined ? '' : encryptSharing(JSON.stringify(body), secret);
    const headers: Record<string, string> = { 'X-appKey': this.session.clientId, 'X-requestId': requestId,
      'X-sid': '', 'X-time': String(Date.now()), 'X-token': this.session.token.access_token };
    headers['X-sign'] = sharingSign(hash, headers, query, encryptedBody);
    headers['content-type'] = 'application/json';
    const data = await response<string>(this.fetcher, this.session.endpoint.replace(/\/$/, '') + path +
      (query ? `?${new URLSearchParams({ encdata: query })}` : ''), {
      method, headers, ...(encryptedBody ? { body: JSON.stringify({ encdata: encryptedBody }) } : {})
    });
    if (!data.success) { logger.warn('request.rejected', { method, path, code: data.code }); throw new Error('Tuya sharing request failed. Try reconnecting with a new QR code.'); }
    const decrypted = decryptSharing(data.result, secret);
    let result: T;
    try { result = JSON.parse(decrypted) as T; } catch { result = decrypted as T; }
    return { result, t: data.t };
  }
  private async authenticate() {
    if (this.session.token.t + this.session.token.expire_time * 1000 - 60000 > Date.now()) return;
    if (!this.refreshing) this.refreshing = (async () => {
      logger.info('session.renew_start');
      const { result, t } = await this.raw<{ accessToken: string; refreshToken: string; expireTime: number; uid: string }>('GET',
        `/v1.0/m/token/${encodeURIComponent(this.session.token.refresh_token)}`);
      this.session = sessionSchema.parse({ ...this.session, token: { t, uid: result.uid, expire_time: result.expireTime,
        access_token: result.accessToken, refresh_token: result.refreshToken } });
      await this.save(this.session);
      logger.info('session.renewed', { expiresInSeconds: result.expireTime });
    })().finally(() => { this.refreshing = undefined; });
    await this.refreshing;
  }
  private async request<T>(method: string, path: string, params?: Record<string, string>, body?: unknown): Promise<T> {
    await this.authenticate();
    return (await this.raw<T>(method, path, params, body)).result;
  }
  async device(id: string): Promise<Device> {
    const devices = await this.request<Device[]>('GET', '/v1.0/m/life/ha/devices/detail', { devIds: id });
    const found = devices.find(d => d.id === id);
    if (!found) throw new Error('Device unavailable in the linked account');
    return found;
  }
  specifications(id: string) { return this.request<Specification>('GET', `/v1.1/m/life/${encodeURIComponent(id)}/specifications`); }
  async devices(): Promise<Device[]> {
    logger.info('discovery.start');
    const homes = await this.request<{ ownerId: string | number }[]>('GET', '/v1.0/m/life/users/homes');
    const devices = new Map<string, Device>();
    for (const home of homes) {
      for (const device of await this.request<Device[]>('GET', '/v1.0/m/life/ha/home/devices', { homeId: String(home.ownerId) })) devices.set(device.id, device);
    }
    logger.info('discovery.complete', { deviceCount: devices.size, homeCount: homes.length });
    return [...devices.values()];
  }
  async command(id: string, code: string, value: unknown) {
    const result = await this.request<unknown>('POST', `/v1.1/m/thing/${encodeURIComponent(id)}/commands`, undefined, { commands: [{ code, value }] });
    if (result === false) throw new Error('Tuya did not accept the command');
  }
}
