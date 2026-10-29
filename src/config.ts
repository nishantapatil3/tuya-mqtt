import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { createLogger } from './logger.js';
const logger = createLogger('config');

const segment = z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Use letters, digits, underscores or hyphens');
const code = z.string().regex(/^[a-zA-Z0-9_]+$/);
export const cloudSchema = z.object({
  region: z.enum(['us', 'us-east', 'eu', 'eu-west', 'cn', 'in', 'sg']),
  accessId: z.string().min(1), accessSecret: z.string().min(1),
  uid: z.string().min(1).optional()
});
export const blindSchema = z.object({
  type: z.literal('blind').default('blind'),
  id: segment, name: z.string().min(1), topic: segment.optional(),
  positionCode: code.default('percent_state'),
  targetCode: code.default('percent_control'), controlCode: code.default('control'),
  openValue: z.string().min(1).default('open'), closeValue: z.string().min(1).default('close'),
  stopValue: z.string().min(1).default('stop'),
  invertPosition: z.boolean().default(false),
  positionMin: z.number().int().default(0), positionMax: z.number().int().default(100),
  targetMin: z.number().int().optional(), targetMax: z.number().int().optional(),
  targetStep: z.number().int().positive().default(1),
  targetAsString: z.boolean().default(false),
  workStateCode: code.optional(),
  openingValue: z.string().default('opening'), closingValue: z.string().default('closing'),
  stoppedValue: z.string().default('stopped')
}).refine(d => d.positionMax > d.positionMin, 'positionMax must exceed positionMin')
  .refine(d => (d.targetMax ?? d.positionMax) > (d.targetMin ?? d.positionMin), 'targetMax must exceed targetMin')
  .refine(d => ((d.targetMax ?? d.positionMax) - (d.targetMin ?? d.positionMin)) % d.targetStep === 0,
    'Target range must be divisible by targetStep');
export const deviceSchema = blindSchema;
export const configSchema = z.object({
  mqttUrl: z.string().refine(value => {
    try { const u = new URL(value); return ['mqtt:', 'mqtts:'].includes(u.protocol) && !!u.hostname; } catch { return false; }
  }, 'Enter an mqtt:// or mqtts:// broker URL'),
  topicPrefix: z.string().regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/).default('tuya'),
  clientId: segment.default('tuya-mqtt'),
  mqttProtocolVersion: z.union([z.literal(4), z.literal(5)]).default(4),
  pollIntervalSeconds: z.number().int().min(10).max(86400).default(60),
  motionPollSeconds: z.number().int().min(1).max(60).default(1),
  motionTimeoutSeconds: z.number().int().min(5).max(300).default(60),
  authMode: z.enum(['cloud', 'sharing']).default('cloud'),
  tuyaCloud: cloudSchema.optional(),
  devices: z.array(deviceSchema).min(1).max(50)
}).superRefine((c, ctx) => {
  if (c.authMode === 'cloud' && !c.tuyaCloud) ctx.addIssue({ code: 'custom', message: 'Cloud mode requires tuyaCloud credentials' });
  if (new Set(c.devices.map(d => d.id)).size !== c.devices.length ||
      new Set(c.devices.map(d => d.topic ?? d.id)).size !== c.devices.length)
    ctx.addIssue({ code: 'custom', message: 'Device IDs and topics must be unique' });
});
export type Config = z.infer<typeof configSchema>;
export type BlindConfig = z.infer<typeof blindSchema>;
export type DeviceConfig = z.infer<typeof deviceSchema>;
export type CloudConfig = z.infer<typeof cloudSchema>;
export async function loadConfig(path: string): Promise<Config> {
  const data = JSON.parse(await readFile(path, 'utf8'));
  if ((data.authMode ?? 'cloud') === 'cloud') data.tuyaCloud = { ...data.tuyaCloud,
    ...(process.env.TUYA_ACCESS_ID ? { accessId: process.env.TUYA_ACCESS_ID } : {}),
    ...(process.env.TUYA_ACCESS_SECRET ? { accessSecret: process.env.TUYA_ACCESS_SECRET } : {}) };
  if (process.env.MQTT_URL) data.mqttUrl = process.env.MQTT_URL;
  const config = configSchema.parse(data);
  logger.info('loaded', { path, authMode: config.authMode, deviceCount: config.devices.length });
  return config;
}
