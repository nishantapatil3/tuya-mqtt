import { blindSchema, type BlindConfig, type Config, type DeviceConfig } from './config.js';
import type { Datapoint, Specification, Device } from './cloud.js';
import { suggestPump } from './watering-pump.js';

export function suggestDevice(device: Device, spec: Specification): DeviceConfig | undefined {
  return suggestBlind(device, spec) ?? suggestPump(device, spec);
}

export function suggestBlind(device: Device, spec: Specification): BlindConfig | undefined {
  if (!['cl', 'clkg'].includes(device.category ?? '')) return;
  const position = spec.status.find(s => ['percent_state', 'position'].includes(s.code));
  const target = spec.functions.find(s => ['percent_control', 'position'].includes(s.code));
  if (!position || !target) return;
  try {
    const range = JSON.parse(target.values);
    const blind = blindSchema.parse({ id: device.id, name: device.name, positionCode: position.code,
      targetCode: target.code, targetAsString: target.type.toLowerCase() === 'string',
      positionMin: range.min ?? 0, positionMax: range.max ?? 100 });
    validateMapping(blind, spec);
    return blind;
  } catch { return; }
}

export function toHome(value: unknown, c: BlindConfig): number | undefined {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && value.trim() === '')) return;
  const n = Number(value);
  if (!Number.isFinite(n) || n < c.positionMin || n > c.positionMax) return;
  const percent = Math.round((n - c.positionMin) * 100 / (c.positionMax - c.positionMin));
  return c.invertPosition ? 100 - percent : percent;
}
export function toTuya(percent: number, c: BlindConfig): number | string {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new Error('Position must be an integer from 0 to 100');
  const raw = Math.round(c.positionMin + (c.invertPosition ? 100 - percent : percent) * (c.positionMax - c.positionMin) / 100);
  return c.targetAsString ? String(raw) : raw;
}
export function observed(status: Datapoint[], c: BlindConfig, previous?: number) {
  const values = new Map(status.map(d => [d.code, d.value]));
  const current = toHome(values.get(c.positionCode), c);
  const target = toHome(values.get(c.targetCode), c);
  let state: string | undefined;
  const work = c.workStateCode ? values.get(c.workStateCode) : undefined;
  // Work-state enum values describe physical opening/closing, regardless of percentage inversion.
  if (work === c.openingValue) state = 'INCREASING';
  else if (work === c.closingValue) state = 'DECREASING';
  else if (work === c.stoppedValue) state = 'STOPPED';
  else if (current !== undefined) state = previous === undefined || current === previous ? 'STOPPED' : current > previous ? 'INCREASING' : 'DECREASING';
  return { current, target, state };
}
export function validateMapping(c: BlindConfig, spec: Specification) {
  const target = spec.functions.find(f => f.code === c.targetCode);
  const control = spec.functions.find(f => f.code === c.controlCode);
  if (!target || !control || !spec.status.some(s => s.code === c.positionCode))
    throw new Error(`Blind ${c.id}: position, target or control code missing; inspect the device mappings`);
  if (target.type.toLowerCase() !== (c.targetAsString ? 'string' : 'integer'))
    throw new Error(`Blind ${c.id}: target type does not match targetAsString`);
  const range = JSON.parse(target.values);
  if (typeof range.min === 'number' && (range.min > c.positionMin || range.max < c.positionMax))
    throw new Error(`Blind ${c.id}: configured position range exceeds the device range`);
  if (typeof range.step === 'number' && range.step > 1)
    throw new Error(`Blind ${c.id}: target step ${range.step} is unsupported; v0.1 requires step 1`);
  const values = JSON.parse(control.values).range;
  if (!Array.isArray(values) || ![c.openValue, c.closeValue, c.stopValue].every(v => values.includes(v)))
    throw new Error(`Blind ${c.id}: open, close or stop values are unsupported`);
}
export function baseTopic(config: Config, device: DeviceConfig) { return `${config.topicPrefix}/${device.topic ?? device.id}`; }
export function mqttthing(config: Config) {
  // The setup export does not disclose broker credentials.
  const broker = new URL(config.mqttUrl); broker.username = ''; broker.password = '';
  return config.devices.map(device => {
    const base = baseTopic(config, device);
    return {
      accessory: 'mqttthing', type: device.type === 'wateringPump' ? 'valve' : 'windowCovering', name: device.name, url: broker.toString(),
      ...(device.type === 'wateringPump' ? {
        valveType: 'sprinkler', durationTimer: true, minDuration: 1, maxDuration: 3600,
        onValue: 'true', offValue: 'false'
      } : {}),
      ...(new URL(config.mqttUrl).username ? { username: 'YOUR_MQTT_USERNAME', password: 'YOUR_MQTT_PASSWORD' } : {}),
      onlineValue: 'online', offlineValue: 'offline',
      topics: {
        ...(device.type === 'wateringPump' ? {
          getActive: `${base}/on`, setActive: `${base}/on/set`, getInUse: `${base}/on`
        } : {
        getCurrentPosition: `${base}/position`, getTargetPosition: `${base}/target`,
        setTargetPosition: `${base}/target/set`, getPositionState: `${base}/position_state`,
        setHoldPosition: `${base}/hold/set`,
        }),
        getOnline: {
          topic: `${config.topicPrefix}/status`,
          apply: `const s = JSON.parse(message); return s.online && s.devices[${JSON.stringify(device.id)}] ? 'online' : 'offline';`
        }
      }
    };
  });
}
