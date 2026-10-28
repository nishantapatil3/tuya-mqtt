import { connect, type MqttClient } from 'mqtt';
import { TuyaCloud, type Device, type Specification } from './cloud.js';
import type { Config, BlindConfig } from './config.js';
import { baseTopic, observed, toTuya, validateMapping } from './blind.js';

export interface Cloud {
  device(id: string): Promise<Device>;
  specifications(id: string): Promise<Specification>;
  command(id: string, code: string, value: unknown): Promise<void>;
}
type Runtime = {
  config: BlindConfig; online: boolean; current?: number; target?: number;
  movingUntil: number; failures: number; validated: boolean; timer?: NodeJS.Timeout;
  queue: Promise<void>; queued: number; pendingStop?: boolean;
};
export class TuyaBridge {
  private client?: MqttClient;
  private stopped = false;
  private generation = 0;
  private states: Runtime[];
  constructor(readonly config: Config, private cloud: Cloud = new TuyaCloud(config.tuyaCloud!),
    private log: (message: string) => void = console.log) {
    this.states = config.devices.map(config => ({ config, online: false, movingUntil: 0, failures: 0, validated: false, queue: Promise.resolve(), queued: 0 }));
  }
  get status() {
    return { connected: this.client?.connected ?? false, devices: this.states.map(s => ({
      id: s.config.id, name: s.config.name, online: s.online, current: s.current, target: s.target
    })) };
  }
  start() {
    if (this.client) throw new Error('Bridge already started');
    this.client = connect(this.config.mqttUrl, {
      clientId: this.config.clientId, protocolVersion: this.config.mqttProtocolVersion,
      reconnectPeriod: 5000, connectTimeout: 15000,
      queueQoSZero: false,
      will: { topic: `${this.config.topicPrefix}/status`, payload: Buffer.from(JSON.stringify({ online: false, devices: {} })), qos: 1, retain: true }
    });
    this.client.on('error', () => this.log('MQTT connection error; check broker address, authentication and permissions'));
    this.client.on('offline', () => { this.generation++; this.log('MQTT disconnected; reconnecting'); });
    this.client.on('connect', () => {
      void this.connected().catch(() => {
        this.log('MQTT subscription failed; check broker permissions');
        this.client?.reconnect();
      });
    });
    this.client.on('message', (topic, payload, packet) => {
      if (this.stopped || packet.retain) return; // Do not replay retained motor commands on a restart.
      const state = this.states.find(s => topic.startsWith(baseTopic(this.config, s.config) + '/'));
      if (!state || payload.length > 128) return;
      this.enqueue(state, async () => {
        try { await this.handle(state, topic, payload.toString()); }
        catch (error) {
          this.log(`Command failed for ${state.config.id}: ${safeError(error)}`);
          this.publish(`${baseTopic(this.config, state.config)}/error`, 'Command rejected or failed; check bridge logs', false);
          // Reconcile after an ambiguous command result, without replaying the command.
          await this.refresh(state);
        }
      });
    });
  }
  private async connected() {
    if (this.stopped) return;
    this.generation++;
    // Retain-as-published also rejects retained live commands under MQTT 5.
    await this.client!.subscribeAsync(Object.fromEntries(this.states.flatMap(s =>
      ['target/set', 'hold/set', 'command/set'].map(suffix => [`${baseTopic(this.config, s.config)}/${suffix}`, { qos: 1, rap: true }]))));
    if (this.stopped) return;
    for (const state of this.states) {
      state.online = false;
      clearTimeout(state.timer);
      this.enqueue(state, () => this.refresh(state));
    }
    this.publishStatus();
  }
  private enqueue(state: Runtime, work: () => Promise<void>) {
    if (state.queued >= 32) { this.log(`Device ${state.config.id}: command queue full`); return; }
    const generation = this.generation;
    state.queued++;
    state.queue = state.queue.then(async () => {
      if (!this.stopped && this.client?.connected && generation === this.generation) await work();
    }).catch(error => this.log(`Device ${state.config.id}: ${safeError(error)}`)).finally(() => { state.queued--; });
  }
  private publish(topic: string, payload: string, retain = true) {
    if (!this.stopped && this.client?.connected) this.client.publish(topic, payload, { retain, qos: 1 }, error => {
      if (error) this.log('MQTT publish failed');
    });
  }
  private publishStatus() {
    this.publish(`${this.config.topicPrefix}/status`, JSON.stringify({
      online: true, devices: Object.fromEntries(this.states.map(s => [s.config.id, s.online]))
    }));
  }
  private schedule(state: Runtime) {
    clearTimeout(state.timer);
    if (this.stopped) return;
    const seconds = state.failures ? Math.min(900, this.config.pollIntervalSeconds * 2 ** Math.min(state.failures, 4)) :
      Date.now() < state.movingUntil ? this.config.motionPollSeconds : this.config.pollIntervalSeconds;
    state.timer = setTimeout(() => this.enqueue(state, () => this.refresh(state)), seconds * 1000);
  }
  private async refresh(state: Runtime) {
    const generation = this.generation;
    clearTimeout(state.timer);
    const c = state.config, base = baseTopic(this.config, c);
    try {
      if (!state.validated) {
        validateMapping(c, await this.cloud.specifications(c.id));
        state.validated = true;
      }
      if (this.stopped || generation !== this.generation) return;
      const device = await this.cloud.device(c.id);
      if (this.stopped || generation !== this.generation) return;
      const reading = observed(device.status ?? [], c, state.current);
      state.online = device.online === true && reading.current !== undefined;
      state.failures = 0;
      if (state.online) {
        state.current = reading.current;
        if (state.pendingStop) {
          state.target = reading.current; state.pendingStop = false; state.movingUntil = 0;
        }
        // A target DP can be a command echo. While a command is pending, keep the accepted target.
        else if (Date.now() >= state.movingUntil) state.target = reading.target ?? reading.current;
        const reached = Date.now() < state.movingUntil && state.current === state.target;
        if (reached) state.movingUntil = 0;
        this.publish(`${base}/position`, String(state.current));
        if (state.target !== undefined) this.publish(`${base}/target`, String(state.target));
        this.publish(`${base}/position_state`, reached ? 'STOPPED' : reading.state ?? 'STOPPED');
      }
    } catch (error) {
      if (this.stopped || generation !== this.generation) return;
      state.online = false; state.failures++;
      this.log(`Refresh failed for ${c.id}: ${safeError(error)}`);
    }
    this.publish(`${base}/availability`, state.online ? 'online' : 'offline');
    this.publishStatus();
    this.schedule(state);
  }
  private async handle(state: Runtime, topic: string, payload: string) {
    const generation = this.generation;
    const base = baseTopic(this.config, state.config), c = state.config;
    if (!state.validated || !state.online) throw new Error('Blind unavailable; wait for a successful refresh');
    let code: string, value: unknown, target: number | undefined;
    if (topic === `${base}/target/set`) {
      if (!/^(?:\d|[1-9]\d|100)$/.test(payload)) throw new Error('Expected an integer position from 0 to 100');
      target = Number(payload); code = c.targetCode; value = toTuya(target, c);
    } else if (topic === `${base}/hold/set`) {
      if (['false', '0'].includes(payload)) return;
      if (!['true', '1'].includes(payload)) throw new Error('Expected true or false');
      code = c.controlCode; value = c.stopValue;
    } else if (topic === `${base}/command/set`) {
      const command = payload.toUpperCase();
      if (!['OPEN', 'CLOSE', 'STOP'].includes(command)) throw new Error('Expected OPEN, CLOSE or STOP');
      code = c.controlCode;
      value = command === 'OPEN' ? c.openValue : command === 'CLOSE' ? c.closeValue : c.stopValue;
      target = command === 'OPEN' ? 100 : command === 'CLOSE' ? 0 : undefined;
    } else return;
    await this.cloud.command(c.id, code, value);
    if (this.stopped || generation !== this.generation) return;
    state.target = target ?? state.current;
    state.pendingStop = target === undefined;
    state.movingUntil = Date.now() + this.config.motionTimeoutSeconds * 1000;
    if (state.target !== undefined) this.publish(`${base}/target`, String(state.target));
    await this.refresh(state);
  }
  async stop() {
    this.stopped = true;
    this.states.forEach(s => clearTimeout(s.timer));
    if (!this.client) return;
    if (this.client.connected) {
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          this.client.publishAsync(`${this.config.topicPrefix}/status`, JSON.stringify({ online: false, devices: {} }), { retain: true, qos: 1 }),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Shutdown timeout')), 3000); })
        ]);
      } catch { /* Last will covers disconnects. */ }
      finally { clearTimeout(timeout); }
    }
    await this.client.endAsync(true);
    // In-flight refreshes check stopped before publishing or scheduling another poll.
  }
}
export function safeError(error: unknown) {
  // Never log HTTP request objects, broker URLs, credentials or Tuya response messages.
  if (error instanceof Error && /^(Blind |Position |Expected |Blind unavailable|Tuya HTTP |Tuya connection|Tuya did not)/.test(error.message)) return error.message;
  if (error instanceof Error && /^Tuya \d+:/.test(error.message)) return error.message.split(':')[0];
  if (error instanceof Error && /^(QR login |Could not create a QR|Tuya sharing request failed)/.test(error.message)) return error.message;
  return 'Request failed; check cloud permissions, region and configuration';
}
