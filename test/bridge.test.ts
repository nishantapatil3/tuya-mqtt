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
      return { functions: [
      { code: 'percent_control', type: 'Integer', values: '{"min":0,"max":100,"step":1}' },
      { code: 'control', type: 'Enum', values: '{"range":["open","close","stop"]}' }
    ], status: [{ code: 'percent_state', type: 'Integer', values: '{}' }] }; },
    async device(id) {
      if (id === 'bedroom') return { id, name: 'Bedroom blinds', online: true, status: [{ code: 'percent_state', value: 50 }] };
      return { id: 'blind', name: 'Blinds', online, status: [
        { code: 'percent_state', value: current },
        { code: 'percent_control', value: 0 } // A stale command echo, not the stopped position.
      ] };
    },
    async command(id, code, value) { commands.push({ code, value }); if (fail) throw new Error('Cloud command failed'); }
  };
  const config = configSchema.parse({ mqttUrl: url, mqttProtocolVersion: 4,
    tuyaCloud: { region: 'us', accessId: 'test', accessSecret: 'test' },
    devices: [{ id: 'blind', topic: 'living-room', name: 'Blinds' }, { type: 'blind', id: 'bedroom', topic: 'bedroom', name: 'Bedroom blinds' }] });
  const bridge = new TuyaBridge(config, cloud, () => {});
  t.after(async () => { await bridge.stop(); await mqtt.endAsync(true); await new Promise<void>(r => broker.close(r)); await new Promise<void>(r => server.close(() => r())); });
  bridge.start();
  await until(() => messages.get('tuya/living-room/position') === '10');
  await until(() => messages.get('tuya/bedroom/position') === '50');
  assert.equal(messages.get('tuya/living-room/target'), '10', 'Idle target must match measured position rather than an old command echo');
  assert.equal(messages.get('tuya/living-room/position_state'), 'STOPPED');
  assert.equal(commands.length, 0, 'Retained command must not move a blind');
  await mqtt.publishAsync('tuya/living-room/target/set', '75', { qos: 1 });
  await until(() => messages.get('tuya/living-room/target') === '75');
  assert.deepEqual(commands[0], { code: 'percent_control', value: 75 });
  assert.equal(messages.get('tuya/living-room/position'), '10', 'Accepted target is not current position');
  assert.equal(messages.get('tuya/bedroom/position'), '50', 'Commands for one blind must not alter another');
  current = 25;
  await until(() => messages.get('tuya/living-room/position') === '25', 2500);
  assert.equal(messages.get('tuya/living-room/target'), '75', 'One-second tracking preserves the pending target');
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
  assert.equal(JSON.parse(messages.get('tuya/status')!).devices.bedroom, true, 'Availability is isolated per blind');
  await bridge.stop();
  await until(() => JSON.parse(messages.get('tuya/status')!).online === false);
});

for (const command of ['OPEN', 'CLOSE', 'STOP', 'target', 'hold']) {
  test(`${command}: confirmed commands keep polling for 20 seconds, and another command restarts the window`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    let polls = 0;
    const cloud: Cloud = {
      async specifications() { throw new Error('Already validated'); },
      async device() {
        polls++;
        return { id: 'blind', name: 'Blind', online: true, status: [{ code: 'percent_state', value: command === 'CLOSE' ? 0 : 100 }] };
      },
      async command() {}
    };
    const bridge = new TuyaBridge(configSchema.parse({ mqttUrl: 'mqtt://localhost', authMode: 'sharing',
      devices: [{ id: 'blind', name: 'Blind' }] }), cloud, () => {});
    const state = bridge['states'][0]!;
    state.validated = true; state.online = true; state.current = 100;
    let pending = Promise.resolve();
    t.mock.method(bridge, 'enqueue', (_state: unknown, work: () => Promise<void>) => { pending = work(); });
    const topic = command === 'target' ? 'target/set' : command === 'hold' ? 'hold/set' : 'command/set';
    const payload = command === 'target' ? '100' : command === 'hold' ? 'true' : command;
    const send = () => bridge['handle'](state, `tuya/blind/${topic}`, payload);
    const tick = async () => { t.mock.timers.tick(1000); await pending; };
    await send();
    assert.equal(state.movingUntil, 0, 'The first cloud reading confirms completion');
    for (let second = 1; second <= 10; second++) await tick();
    assert.equal(polls, 11, 'Read every second after immediate confirmation');
    await send();
    for (let second = 1; second <= 20; second++) await tick();
    assert.equal(polls, 32, 'A new command gets its full 20-second window');
    for (let second = 1; second < 60; second++) await tick();
    assert.equal(polls, 32, 'Idle polling waits 60 seconds');
    await tick();
    assert.equal(polls, 33);
    await bridge.stop();
  });
}

test('pending movement keeps fast polling beyond the post-command window', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let polls = 0;
  const cloud: Cloud = {
    async specifications() { throw new Error('Already validated'); },
    async device() {
      polls++;
      return { id: 'blind', name: 'Blind', online: true, status: [{ code: 'percent_state', value: 10 }] };
    },
    async command() {}
  };
  const bridge = new TuyaBridge(configSchema.parse({ mqttUrl: 'mqtt://localhost', authMode: 'sharing',
    devices: [{ id: 'blind', name: 'Blind' }] }), cloud, () => {});
  const state = bridge['states'][0]!;
  state.validated = true; state.online = true; state.current = 10;
  let pending = Promise.resolve();
  t.mock.method(bridge, 'enqueue', (_state: unknown, work: () => Promise<void>) => { pending = work(); });
  await bridge['handle'](state, 'tuya/blind/command/set', 'OPEN');
  for (let second = 1; second <= 60; second++) {
    t.mock.timers.tick(1000); await pending;
  }
  assert.equal(polls, 61, 'Track pending movement until the existing motion timeout');
  t.mock.timers.tick(59_000); await pending;
  assert.equal(polls, 61);
  t.mock.timers.tick(1000); await pending;
  assert.equal(polls, 62, 'Return to idle polling after the motion timeout');
  await bridge.stop();
});
