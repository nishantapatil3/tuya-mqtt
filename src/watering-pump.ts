import { wateringPumpSchema, type WateringPumpConfig } from './config.js';
import type { Device, Specification, Datapoint } from './cloud.js';

export function validatePump(c: WateringPumpConfig, spec: Specification) {
  const writable = spec.functions.some(f => f.code === c.switchCode && f.type.toLowerCase() === 'boolean');
  const readable = spec.status.some(s => s.code === c.switchCode && s.type.toLowerCase() === 'boolean');
  if (!writable || !readable) throw new Error(`Device ${c.id}: watering pump requires a readable and writable Boolean ${c.switchCode} code`);
}
export function suggestPump(device: Device, spec: Specification): WateringPumpConfig | undefined {
  if (device.category !== 'ggq') return;
  const config = wateringPumpSchema.parse({ type: 'wateringPump', id: device.id, name: device.name });
  try { validatePump(config, spec); return config; } catch { return; }
}
export function pumpState(status: Datapoint[], c: WateringPumpConfig): boolean | undefined {
  const value = status.find(s => s.code === c.switchCode)?.value;
  return typeof value === 'boolean' ? value : undefined;
}
export function pumpCommand(payload: string): boolean {
  if (payload === 'true' || payload === '1') return true;
  if (payload === 'false' || payload === '0') return false;
  throw new Error('Expected true or false for the watering pump');
}
