import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { Aedes } from 'aedes';
import { connectAsync } from 'mqtt';
import { TuyaBridge, type Cloud } from '../src/bridge.js';
import { configSchema } from '../src/config.js';

async function until(predicate: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('Condition timed out');
    await new Promise(r => setTimeout(r, 20));
  }
}
test('real MQTT round trip: retained state, commands, confirmed positions, offline state and shutdown', async t => {
  // Aedes supports MQTT 3.1.1, so this exercises the compatibility mode.
  const broker = await Aedes.createBroker();
  const server = createServer(broker.handle); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const url = `mqtt://127.0.0.1:${port}`;
  const mqtt = await connectAsync(url);
  const messages = new Map<string, string>();
  mqtt.on('message', (topic, payload) => messages.set(topic, payload.toString()));
  await mqtt.subscribeAsync('tuya/#');
  await mqtt.publishAsync('tuya/living-room/target/set', '100', { retain: true, qos: 1 });
  let current = 10, online = true, fail = false;
  const commands: { code: string; value: unknown }[] = [];
  const cloud: Cloud = {
    async specifications(id) {
      if (id === 'pump') return { functions: [{ code: 'switch', type: 'Boolean', values: '{}' }], status: [{ code: 'switch', type: 'Boolean', values: '{}' }] };
      return { functions: [
      { code: 'percent_control', type: 'Integer', values: '{"min":0,"max":100,"step":1}' },
      { code: 'control', type: 'Enum', values: '{"range":["open","close","stop"]}' }
    ], status: [{ code: 'percent_state', type: 'Integer', values: '{}' }] }; },
    async device(id) {
      if (id === 'pump') return { id, name: 'Pump', online: true, status: [{ code: 'switch', value: false }] };
      return { id: 'blind', name: 'Blinds', online, status: [
        { code: 'percent_state', value: current },
        { code: 'percent_control', value: 0 } // A stale command echo, not the stopped position.
      ] };
    },
    async command(id, code, value) { commands.push({ code, value }); if (fail) throw new Error('Cloud command failed'); }
  };
  const config = configSchema.parse({ mqttUrl: url, mqttProtocolVersion: 4,
    tuyaCloud: { region: 'us', accessId: 'test', accessSecret: 'test' },
    devices: [{ id: 'blind', topic: 'living-room', name: 'Blinds' }, { type: 'wateringPump', id: 'pump', topic: 'plant-pump', name: 'Pump' }] });
  const bridge = new TuyaBridge(config, cloud, () => {});
  t.after(async () => { await bridge.stop(); await mqtt.endAsync(true); await new Promise<void>(r => broker.close(r)); await new Promise<void>(r => server.close(() => r())); });
  bridge.start();
  await until(() => messages.get('tuya/living-room/position') === '10');
  await until(() => messages.get('tuya/plant-pump/on') === 'false');
  assert.equal(messages.get('tuya/living-room/target'), '10', 'Idle target must match measured position rather than an old command echo');
  assert.equal(messages.get('tuya/living-room/position_state'), 'STOPPED');
  assert.equal(commands.length, 0, 'Retained command must not move a blind');
  await mqtt.publishAsync('tuya/living-room/target/set', '75', { qos: 1 });
  await until(() => messages.get('tuya/living-room/target') === '75');
  assert.deepEqual(commands[0], { code: 'percent_control', value: 75 });
  assert.equal(messages.get('tuya/living-room/position'), '10', 'Accepted target is not current position');
  assert.equal(messages.get('tuya/plant-pump/on'), 'false', 'Blind commands must not alter the pump');
  await mqtt.publishAsync('tuya/living-room/target/set', '101');
  await until(() => messages.has('tuya/living-room/error'));
  assert.equal(commands.length, 1);
  current = 40;
  await mqtt.publishAsync('tuya/living-room/hold/set', 'true');
  await until(() => messages.get('tuya/living-room/position') === '40');
  assert.deepEqual(commands.at(-1), { code: 'control', value: 'stop' });
  assert.equal(messages.get('tuya/living-room/target'), '40', 'Stop reconciles the target to the actual stopped position');
  const beforeFailure = commands.length;
  fail = true;
  await mqtt.publishAsync('tuya/living-room/target/set', '85');
  await until(() => commands.length === beforeFailure + 1);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(messages.get('tuya/living-room/target'), '40', 'Failed command does not report an accepted target');
  fail = false;
  const beforeReconnect = commands.length;
  broker.clients['tuya-mqtt']!.conn.destroy();
  await until(() => JSON.parse(messages.get('tuya/status')!).online === false);
  await until(() => JSON.parse(messages.get('tuya/status')!).online === true, 8000);
  await until(() => messages.get('tuya/living-room/availability') === 'online');
  assert.equal(messages.get('tuya/living-room/target'), '40', 'Reconnect must not restore a stale target for a stopped blind');
  assert.equal(commands.length, beforeReconnect, 'Reconnect must not replay retained commands');
  online = false;
  await mqtt.publishAsync('tuya/living-room/command/set', 'CLOSE');
  await until(() => messages.get('tuya/living-room/availability') === 'offline');
  assert.equal(JSON.parse(messages.get('tuya/status')!).devices.blind, false);
  assert.equal(JSON.parse(messages.get('tuya/status')!).devices.pump, true, 'Availability is isolated per device type');
  await bridge.stop();
  await until(() => JSON.parse(messages.get('tuya/status')!).online === false);
});
