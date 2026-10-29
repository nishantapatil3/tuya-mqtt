import { blindSchema, type BlindConfig, type Config, type DeviceConfig } from './config.js';
import type { Datapoint, Specification, Device } from './cloud.js';

export function suggestDevice(device: Device, spec: Specification): DeviceConfig | undefined {
  return suggestBlind(device, spec);
}

// Command aliases follow homebridge-tuya's curtain handling; state must still
// come from a readable position datapoint, never an inferred command echo.
const openAliases = ['open', 'opening', 'ZZ'];
const closeAliases = ['close', 'closing', 'FZ'];
const stopAliases = ['stop', 'STOP', 'stopped'];
type Schema = Specification['status'][number];
function findCode(schemas: Schema[], codes: string[]) {
  return codes.map(code => schemas.find(s => s.code === code)).find(Boolean);
}
function enumValues(schema: Schema): string[] {
  const range: unknown = JSON.parse(schema.values).range;
  return Array.isArray(range) && range.every(v => typeof v === 'string') ? range : [];
}
function enumMapping(schema: Schema) {
  if (schema.type.toLowerCase() !== 'enum') return;
  const range = enumValues(schema);
  const open = openAliases.find(v => range.includes(v));
  const close = closeAliases.find(v => range.includes(v));
  const stop = stopAliases.find(v => range.includes(v));
  return open && close && stop ? { open, close, stop } : undefined;
}
export function suggestBlind(device: Device, spec: Specification): BlindConfig | undefined {
  if (!['cl', 'clkg', 'mc'].includes(device.category ?? '')) return;
  try {
    const position = findCode(spec.status, ['percent_state', 'position']);
    const target = findCode(spec.functions, ['percent_control', 'position']);
    // A shared writable position DP may just echo commands. Require an explicit
    // manual mapping for such devices instead of promising measured feedback.
    if (!position || !target || position.code === target.code) return;
    const control = ['control', 'mach_operate'].map(code => spec.functions.find(s => s.code === code))
      .find(s => s && enumMapping(s));
    if (!control) return;
    const commands = enumMapping(control)!;
    const range = JSON.parse(target.values), currentRange = JSON.parse(position.values);
    const positionMin = currentRange.min ?? range.min ?? 0, positionMax = currentRange.max ?? range.max ?? 100;
    const work = spec.status.find(s => s.code === 'work_state' && enumMapping(s));
    const motion = work ? enumMapping(work)! : undefined;
    const blind = blindSchema.parse({ id: device.id, name: device.name, positionCode: position.code,
      targetCode: target.code, targetAsString: target.type.toLowerCase() === 'string',
      positionMin, positionMax,
      targetMin: range.min ?? positionMin, targetMax: range.max ?? positionMax, targetStep: range.step ?? 1,
      controlCode: control.code, openValue: commands.open, closeValue: commands.close, stopValue: commands.stop,
      ...(work && motion ? { workStateCode: work.code, openingValue: motion.open,
        closingValue: motion.close, stoppedValue: motion.stop } : {}) });
    validateMapping(blind, spec);
    return blind;
  } catch { return; }
}

function normalize(value: unknown, min: number, max: number, invert: boolean): number | undefined {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && value.trim() === '')) return;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return;
  const percent = Math.round((n - min) * 100 / (max - min));
  return invert ? 100 - percent : percent;
}
export function toHome(value: unknown, c: BlindConfig): number | undefined {
  return normalize(value, c.positionMin, c.positionMax, c.invertPosition);
}
export function targetToHome(value: unknown, c: BlindConfig): number | undefined {
  return normalize(value, c.targetMin ?? c.positionMin, c.targetMax ?? c.positionMax, c.invertPosition);
}
export function toTuya(percent: number, c: BlindConfig): number | string {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new Error('Position must be an integer from 0 to 100');
  const min = c.targetMin ?? c.positionMin, max = c.targetMax ?? c.positionMax;
  const raw = min + Math.round((c.invertPosition ? 100 - percent : percent) * (max - min) / 100 / c.targetStep) * c.targetStep;
  return c.targetAsString ? String(raw) : raw;
}
export function observed(status: Datapoint[], c: BlindConfig, previous?: number) {
  const values = new Map(status.map(d => [d.code, d.value]));
  const current = toHome(values.get(c.positionCode), c);
  const target = targetToHome(values.get(c.targetCode), c);
  let state: string | undefined;
  const work = c.workStateCode ? values.get(c.workStateCode) : undefined;
  // Explicit motion feedback describes physical actions, independent of inversion.
  if (work === c.openingValue) state = 'INCREASING';
  else if (work === c.closingValue) state = 'DECREASING';
  else if (work === c.stoppedValue) state = 'STOPPED';
  else if (current !== undefined) state = previous === undefined || current === previous ? 'STOPPED' : current > previous ? 'INCREASING' : 'DECREASING';
  // Some motors leave work_state at opening/closing after reaching an end stop.
  if ((current === 100 && state === 'INCREASING') || (current === 0 && state === 'DECREASING')) state = 'STOPPED';
  return { current, target, state };
}
export function validateMapping(c: BlindConfig, spec: Specification) {
  const target = spec.functions.find(f => f.code === c.targetCode);
  const control = spec.functions.find(f => f.code === c.controlCode);
  const position = spec.status.find(s => s.code === c.positionCode);
  if (!target || !control || !position)
    throw new Error(`Blind ${c.id}: position, target or control code missing; inspect the device mappings`);
  if (!['integer', 'string'].includes(position.type.toLowerCase()))
    throw new Error(`Blind ${c.id}: position must be numeric or a numeric string`);
  if (target.type.toLowerCase() !== (c.targetAsString ? 'string' : 'integer'))
    throw new Error(`Blind ${c.id}: target type does not match targetAsString`);
  const range = JSON.parse(target.values), currentRange = JSON.parse(position.values);
  const min = c.targetMin ?? c.positionMin, max = c.targetMax ?? c.positionMax;
  if ((typeof range.min === 'number' && min < range.min) || (typeof range.max === 'number' && max > range.max))
    throw new Error(`Blind ${c.id}: configured target range exceeds the device range`);
  if ((typeof currentRange.min === 'number' && c.positionMin < currentRange.min) ||
      (typeof currentRange.max === 'number' && c.positionMax > currentRange.max))
    throw new Error(`Blind ${c.id}: configured position range exceeds the device range`);
  if (typeof range.step === 'number' && (range.step <= 0 || c.targetStep % range.step !== 0 || (min - (range.min ?? 0)) % range.step !== 0))
    throw new Error(`Blind ${c.id}: targetStep and targetMin must align with the device step`);
  if (control.type.toLowerCase() !== 'enum' || ![c.openValue, c.closeValue, c.stopValue].every(v => enumValues(control).includes(v)))
    throw new Error(`Blind ${c.id}: open, close or stop values are unsupported`);
  if (new Set([c.openValue, c.closeValue, c.stopValue]).size !== 3)
    throw new Error(`Blind ${c.id}: open, close and stop must be distinct`);
  if (c.workStateCode) {
    const work = spec.status.find(s => s.code === c.workStateCode);
    if (!work || work.type.toLowerCase() !== 'enum' ||
        ![c.openingValue, c.closingValue, c.stoppedValue].every(v => enumValues(work).includes(v)) ||
        new Set([c.openingValue, c.closingValue, c.stoppedValue]).size !== 3)
      throw new Error(`Blind ${c.id}: motion feedback mapping is unsupported`);
  }
}
export function baseTopic(config: Config, device: DeviceConfig) { return `${config.topicPrefix}/${device.topic ?? device.id}`; }
export function mqttthing(config: Config) {
  // The setup export does not disclose broker credentials.
  const broker = new URL(config.mqttUrl); broker.username = ''; broker.password = '';
  return config.devices.map(device => {
    const base = baseTopic(config, device);
    return {
      accessory: 'mqttthing', type: 'windowCovering', name: device.name, url: broker.toString(),
      ...(new URL(config.mqttUrl).username ? { username: 'YOUR_MQTT_USERNAME', password: 'YOUR_MQTT_PASSWORD' } : {}),
      onlineValue: 'online', offlineValue: 'offline',
      topics: {
        getCurrentPosition: `${base}/position`, getTargetPosition: `${base}/target`,
        setTargetPosition: `${base}/target/set`, getPositionState: `${base}/position_state`,
        setHoldPosition: `${base}/hold/set`,
        getOnline: {
          topic: `${config.topicPrefix}/status`,
          apply: `const s = JSON.parse(message); return s.online && s.devices[${JSON.stringify(device.id)}] ? 'online' : 'offline';`
        }
      }
    };
  });
}
