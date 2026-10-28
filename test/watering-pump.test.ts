import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { Aedes } from 'aedes';
import { connectAsync } from 'mqtt';
import { configSchema, wateringPumpSchema } from '../src/config.js';
import { suggestDevice, mqttthing } from '../src/blind.js';
import { validatePump, pumpState, pumpCommand } from '../src/watering-pump.js';
import { TuyaBridge, type Cloud } from '../src/bridge.js';

const pump = wateringPumpSchema.parse({ type: 'wateringPump', id: 'pump', name: 'Plant Pump', topic: 'plant-pump' });
const spec = {
  functions: [{ code: 'switch', type: 'Boolean', values: '{}' }],
  status: [{ code: 'switch', type: 'Boolean', values: '{}' }]
};
const config = { mqttUrl: 'mqtt://localhost:1883', authMode: 'sharing', devices: [pump] };
async function until(predicate: () => boolean, timeout = 4000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('Condition timed out');
    await new Promise(r => setTimeout(r, 20));
  }
}
test('pump discovery requires a supported category and Boolean read/write capabilities', () => {
  const device = { id: 'pump', name: 'Plant Pump', category: 'ggq', online: true, status: [] };
  assert.equal(suggestDevice(device, spec)?.type, 'wateringPump');
  assert.equal(suggestDevice({ ...device, category: 'cz' }, spec), undefined);
  assert.equal(suggestDevice(device, { ...spec, functions: [] }), undefined);
  assert.throws(() => validatePump(pump, { ...spec, status: [] }));
  assert.throws(() => validatePump(pump, { ...spec, functions: [{ code: 'switch', type: 'String', values: '{}' }] }));
});
test('pump status and commands do not coerce invalid values into motor actions', () => {
  assert.equal(pumpState([{ code: 'switch', value: false }], pump), false);
  assert.equal(pumpState([{ code: 'switch', value: true }], pump), true);
  for (const value of ['false', 'true', 0, 1, null]) assert.equal(pumpState([{ code: 'switch', value }], pump), undefined);
  assert.equal(pumpCommand('true'), true); assert.equal(pumpCommand('0'), false);
  for (const payload of ['', '50', 'OPEN', 'yes', 'null']) assert.throws(() => pumpCommand(payload));
});
test('mixed configurations preserve legacy blinds and export separate mqttthing accessory types', () => {
  const parsed = configSchema.parse({ ...config, devices: [{ id: 'blind', name: 'Blinds' }, pump] });
  assert.equal(parsed.devices[0]?.type, 'blind');
  assert.throws(() => configSchema.parse({ ...config, devices: [{ ...pump, type: 'unknown' }] }));
  const accessories = mqttthing(parsed);
  assert.equal(accessories[0]?.type, 'windowCovering');
  assert.equal(accessories[1]?.type, 'valve');
  assert.equal(accessories[1]?.durationTimer, true);
  assert.equal(accessories[1]?.valveType, 'sprinkler');
  assert.equal(accessories[1]?.minDuration, 1);
  assert.equal(accessories[1]?.maxDuration, 3600);
  assert.equal(accessories[1]?.topics.getActive, 'tuya/plant-pump/on');
  assert.equal(accessories[1]?.topics.setActive, 'tuya/plant-pump/on/set');
  assert.equal(accessories[1]?.onValue, 'true');
  assert.equal(accessories[1]?.offValue, 'false');
});
test('pump MQTT round trip: no retained replay, confirmed state, off command, rejection and availability', async t => {
  const broker = await Aedes.createBroker();
  const server = createServer(broker.handle); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `mqtt://127.0.0.1:${(server.address() as { port: number }).port}`;
  const mqtt = await connectAsync(url);
  const messages = new Map<string, string>();
  mqtt.on('message', (topic, payload) => messages.set(topic, payload.toString()));
  await mqtt.subscribeAsync('tuya/#');
  await mqtt.publishAsync('tuya/plant-pump/on/set', 'true', { retain: true, qos: 1 });
  let on: unknown = false, online = true, fail = false, reflect = false;
  const commands: unknown[] = [];
  const cloud: Cloud = {
    async specifications() { return spec; },
    async device() { return { id: 'pump', name: 'Plant Pump', online, status: [{ code: 'switch', value: on }] }; },
    async command(id, code, value) {
      assert.equal(id, 'pump'); assert.equal(code, 'switch'); commands.push(value);
      if (fail) throw new Error('Command failed');
      if (reflect) on = value;
    }
  };
  const bridge = new TuyaBridge(configSchema.parse({ ...config, mqttUrl: url, motionPollSeconds: 2 }), cloud, () => {});
  t.after(async () => { await bridge.stop(); await mqtt.endAsync(true); await new Promise<void>(r => broker.close(r)); await new Promise<void>(r => server.close(() => r())); });
  bridge.start();
  await until(() => messages.get('tuya/plant-pump/on') === 'false');
  assert.equal(commands.length, 0);
  await mqtt.publishAsync('tuya/plant-pump/on/set', 'true');
  await until(() => commands.length === 1);
  assert.equal(messages.get('tuya/plant-pump/on'), 'false', 'Accepted command must not fabricate state');
  on = true;
  await until(() => messages.get('tuya/plant-pump/on') === 'true');
  reflect = true;
  await mqtt.publishAsync('tuya/plant-pump/on/set', 'false');
  await until(() => messages.get('tuya/plant-pump/on') === 'false');
  assert.deepEqual(commands, [true, false]);
  fail = true;
  await mqtt.publishAsync('tuya/plant-pump/on/set', 'true');
  await until(() => messages.has('tuya/plant-pump/error'));
  assert.equal(messages.get('tuya/plant-pump/on'), 'false');
  const count = commands.length;
  await mqtt.publishAsync('tuya/plant-pump/on/set', 'OPEN');
  await new Promise(r => setTimeout(r, 100));
  assert.equal(commands.length, count);
  fail = false; online = false;
  await mqtt.publishAsync('tuya/plant-pump/on/set', 'false');
  await until(() => messages.get('tuya/plant-pump/availability') === 'offline');
  assert.equal(JSON.parse(messages.get('tuya/status')!).devices.pump, false);
});
