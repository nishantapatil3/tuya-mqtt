import { createHash, createHmac } from 'node:crypto';
import type { CloudConfig } from './config.js';

export const endpoints = {
  us: 'https://openapi.tuyaus.com', 'us-east': 'https://openapi-ueaz.tuyaus.com',
  eu: 'https://openapi.tuyaeu.com', 'eu-west': 'https://openapi-weaz.tuyaeu.com',
  cn: 'https://openapi.tuyacn.com', in: 'https://openapi.tuyain.com', sg: 'https://openapi-sg.iotbing.com'
};
export type Datapoint = { code: string; value: unknown };
export type Device = { id: string; name: string; category?: string; online: boolean; status: Datapoint[] };
export type Specification = { functions: { code: string; type: string; values: string }[]; status: { code: string; type: string; values: string }[] };
type Envelope<T> = { success: boolean; result: T; code?: number; msg?: string };
export class TuyaError extends Error {
  constructor(public code: number | undefined, message: string) { super(`Tuya ${code ?? 'error'}: ${message}`); }
}
export function signature(secret: string, id: string, token: string, time: string, method: string, path: string, body = '') {
  const hash = createHash('sha256').update(body).digest('hex');
  const canonical = [method, hash, '', path].join('\n');
  return createHmac('sha256', secret).update(id + token + time + canonical).digest('hex').toUpperCase();
}
export class TuyaCloud {
  private token = '';
  private expires = 0;
  private refreshing?: Promise<void>;
  constructor(private config: CloudConfig, private fetcher: typeof fetch = fetch) {}
  private async raw<T>(method: string, path: string, body?: unknown, token = this.token): Promise<T> {
    const text = body === undefined ? '' : JSON.stringify(body);
    const t = String(Date.now());
    const headers: Record<string, string> = {
      client_id: this.config.accessId, t, sign_method: 'HMAC-SHA256',
      sign: signature(this.config.accessSecret, this.config.accessId, token, t, method, path, text),
      'content-type': 'application/json'
    };
    if (token) headers.access_token = token;
    let response: Response;
    try {
      response = await this.fetcher(endpoints[this.config.region] + path, {
        method, headers, ...(body === undefined ? {} : { body: text }), signal: AbortSignal.timeout(15000)
      });
    } catch { throw new Error('Tuya connection failed or timed out'); }
    if (!response.ok) throw new Error(`Tuya HTTP ${response.status}`);
    const data = await response.json() as Envelope<T>;
    if (!data.success) throw new TuyaError(data.code, data.msg ?? 'Request failed');
    return data.result;
  }
  private async authenticate() {
    if (this.token && Date.now() < this.expires) return;
    if (!this.refreshing) this.refreshing = (async () => {
      const data = await this.raw<{ access_token: string; expire_time: number }>('GET', '/v1.0/token?grant_type=1', undefined, '');
      if (!data.access_token || !Number.isFinite(data.expire_time)) throw new Error('Invalid Tuya token response');
      this.token = data.access_token;
      this.expires = Date.now() + Math.max(1, data.expire_time - 60) * 1000;
    })().finally(() => { this.refreshing = undefined; });
    await this.refreshing;
  }
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    await this.authenticate();
    const usedToken = this.token;
    try { return await this.raw<T>(method, path, body); }
    catch (error) {
      // Retry only an explicit token rejection; never replay a command after an ambiguous timeout.
      if (!(error instanceof TuyaError) || ![1010, 1011].includes(error.code ?? 0)) throw error;
      if (this.token === usedToken) { this.token = ''; this.expires = 0; }
      await this.authenticate();
      return this.raw<T>(method, path, body);
    }
  }
  device(id: string) { return this.request<Device>('GET', `/v1.0/devices/${encodeURIComponent(id)}`); }
  specifications(id: string) { return this.request<Specification>('GET', `/v1.0/devices/${encodeURIComponent(id)}/specifications`); }
  devices(uid: string) { return this.request<Device[]>('GET', `/v1.0/users/${encodeURIComponent(uid)}/devices`); }
  async command(id: string, code: string, value: unknown) {
    const accepted = await this.request<boolean>('POST', `/v1.0/devices/${encodeURIComponent(id)}/commands`, { commands: [{ code, value }] });
    if (accepted !== true) throw new Error('Tuya did not accept the command');
  }
}
