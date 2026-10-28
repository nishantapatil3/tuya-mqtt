import { loadConfig } from './config.js';
import { TuyaCloud } from './cloud.js';
import { safeError } from './bridge.js';
import { loadSharing } from './storage.js';

try {
  const config = await loadConfig(process.env.TUYA_MQTT_CONFIG ?? './data/config.json');
  const cloud = config.authMode === 'sharing' ? await loadSharing(process.env.TUYA_MQTT_CONFIG ?? './data/config.json') : new TuyaCloud(config.tuyaCloud!);
  for (const blind of config.devices) {
    const device = await cloud.device(blind.id);
    console.log(JSON.stringify({ id: device.id, name: device.name, online: device.online,
      status: device.status, specifications: await cloud.specifications(blind.id) }, null, 2));
  }
} catch (error) { console.error(safeError(error)); process.exitCode = 1; }
