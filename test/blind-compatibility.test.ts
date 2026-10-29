import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { blindSchema, configSchema } from '../src/config.js';
import { observed, suggestBlind, targetToHome, toHome, toTuya, validateMapping } from '../src/blind.js';
import { TuyaBridge, type Cloud } from '../src/bridge.js';
import type { Specification } from '../src/cloud.js';

const device = { id: 'blind', name: 'Curtain', category: 'cl', online: true, status: [] };
const spec: Specification = {
  functions: [
    { code: 'percent_control', type: 'Integer', values: '{"min":10,"max":210,"step":10}' },
    { code: 'mach_operate', type: 'Enum', values: '{"range":["ZZ","FZ","STOP"]}' }
  ],
  status: [
    { code: 'percent_state', type: 'Integer', values: '{"min":0,"max":1000}' },
    { code: 'work_state', type: 'Enum', values: '{"range":["opening","closing","stop"]}' }
  ]
};

test('curtain/window discovery maps legacy commands, actual motion and separate stepped ranges', () => {
  for (const category of ['cl', 'clkg', 'mc']) {
    const c = suggestBlind({ ...device, category }, spec)!;
    assert.ok(c);
    assert.equal(c.controlCode, 'mach_operate');
    assert.deepEqual([c.openValue, c.closeValue, c.stopValue], ['ZZ', 'FZ', 'STOP']);
    assert.equal(c.workStateCode, 'work_state');
    assert.equal(c.stoppedValue, 'stop');
    assert.equal(toHome(500, c), 50);
    assert.equal(toTuya(53, c), 120);
    assert.equal(targetToHome(120, c), 55);
    assert.equal(observed([{ code: 'percent_state', value: 500 }, { code: 'percent_control', value: 120 }], c).target, 55);
    assert.equal(toTuya(0, c), 10);
    assert.equal(toTuya(100, c), 210);
    assert.equal(toTuya(0, { ...c, invertPosition: true }), 210);
    assert.equal(toHome(0, { ...c, invertPosition: true }), 100);
  }
  assert.equal(suggestBlind({ ...device, category: 'ggq' }, spec), undefined);
});


test('string targets and missing feedback range metadata preserve legacy range behavior', () => {
  const legacySpec = { ...spec, functions: [
    { code: 'position', type: 'String', values: '{"min":100,"max":1100}' }, spec.functions[1]!
  ], status: [{ code: 'percent_state', type: 'Integer', values: '{}' }] };
  const c = suggestBlind(device, legacySpec)!;
  assert.ok(c);
  assert.equal(toHome(600, c), 50);
  assert.equal(toTuya(50, c), '600');
  assert.equal(targetToHome('600', c), 50);
});

test('discovery never guesses unknown commands or treats a shared target as measured feedback', () => {
  assert.equal(suggestBlind(device, { ...spec, functions: [spec.functions[0]!,
    { code: 'control', type: 'Enum', values: '{"range":["a","b","c"]}' }] }), undefined);
  const position = { code: 'position', type: 'Integer', values: '{"min":0,"max":100}' };
  assert.equal(suggestBlind(device, { functions: [position, spec.functions[1]!], status: [position] }), undefined);
  assert.equal(suggestBlind(device, { ...spec, status: [] }), undefined);
  const malformed = { ...spec, status: [{ ...spec.status[0]!, values: 'bad JSON' }] };
  assert.equal(suggestBlind(device, malformed), undefined);
});

test('mapping rejects invalid feedback, command types, steps, ranges and motion enums', () => {
  const c = suggestBlind(device, spec)!;
  for (const patch of [
    { positionMax: 1001 }, { targetMax: 220 }, { targetMin: 11 }, { targetStep: 1 },
    { workStateCode: 'missing' }, { stoppedValue: 'unknown' }, { closeValue: 'ZZ' }
  ]) assert.throws(() => validateMapping({ ...c, ...patch }, spec), JSON.stringify(patch));
  assert.throws(() => validateMapping(c, { ...spec, status: [{ ...spec.status[0]!, type: 'Boolean' }] }));
  assert.throws(() => validateMapping(c, { ...spec, functions: [spec.functions[0]!, { ...spec.functions[1]!, type: 'String' }] }));
  assert.throws(() => blindSchema.parse({ id: 'blind', name: 'Blind', targetMin: 100, targetMax: 0 }));
  assert.throws(() => blindSchema.parse({ id: 'blind', name: 'Blind', targetStep: 3 }));
});

test('motion respects physical direction with inversion and clears stale motion at endpoints', () => {
  const c = { ...suggestBlind(device, spec)!, invertPosition: true };
  assert.equal(observed([{ code: 'percent_state', value: 500 }, { code: 'work_state', value: 'opening' }], c).state, 'INCREASING');
  assert.equal(observed([{ code: 'percent_state', value: 0 }, { code: 'work_state', value: 'opening' }], c).state, 'STOPPED');
  assert.equal(observed([{ code: 'percent_state', value: 1000 }, { code: 'work_state', value: 'closing' }], c).state, 'STOPPED');
  assert.equal(observed([{ code: 'percent_state', value: 1000 }, { code: 'work_state', value: 'opening' }], c).state, 'INCREASING');
});

function tracking(t: TestContext, mapping: Record<string, unknown> = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let current = 10, work = 'opening', polls = 0;
  const commands: { code: string; value: unknown }[] = [];
  const cloud: Cloud = {
    async specifications() { throw new Error('Already validated'); },
    async device() {
      polls++;
      return { ...device, status: [{ code: 'percent_state', value: current },
        { code: 'percent_control', value: 0 }, { code: 'work_state', value: work }] };
    },
    async command(_id, code, value) { commands.push({ code, value }); }
  };
  const bridge = new TuyaBridge(configSchema.parse({ authMode: 'sharing', mqttUrl: 'mqtt://localhost',
    devices: [{ id: 'blind', name: 'Curtain', workStateCode: 'work_state', stoppedValue: 'stop', ...mapping }] }), cloud, () => {});
  const state = bridge['states'][0]!;
  state.validated = true; state.online = true; state.current = current;
  let pending = Promise.resolve();
  t.mock.method(bridge, 'enqueue', (_state: unknown, work: () => Promise<void>) => { pending = work(); });
  t.after(() => bridge.stop());
  return { bridge, state, commands, polls: () => polls,
    reading(position: number, motion: string) { current = position; work = motion; },
    refresh: () => bridge['refresh'](state),
    send: (topic: string, payload: string) => bridge['handle'](state, `tuya/blind/${topic}`, payload),
    async tick(ms = 1000) { t.mock.timers.tick(ms); await pending; } };
}

test('quantized targets track the attainable percentage rather than waiting for an impossible target', async t => {
  const f = tracking(t, { targetStep: 5 });
  await f.send('target/set', '53');
  assert.deepEqual(f.commands, [{ code: 'percent_control', value: 55 }]);
  assert.equal(f.state.target, 55);
  assert.equal(f.state.current, 10);
  f.reading(55, 'stop'); await f.tick();
  assert.equal(f.state.current, 55);
  assert.equal(f.state.target, 55);
  assert.equal(f.state.movingUntil, 0);
});

test('stop follows delayed position reports until the motor reports stopped', async t => {
  const f = tracking(t);
  await f.send('command/set', 'OPEN');
  f.reading(35, 'opening');
  await f.send('hold/set', 'true');
  assert.equal(f.state.pendingStop, true);
  assert.equal(f.state.target, 35);
  f.reading(40, 'opening'); await f.tick();
  assert.equal(f.state.target, 40);
  assert.equal(f.state.pendingStop, true);
  f.reading(42, 'stop'); await f.tick();
  assert.equal(f.state.target, 42);
  assert.equal(f.state.positionState, 'STOPPED');
  assert.equal(f.state.pendingStop, false);
  assert.equal(f.state.movingUntil, 0);
  assert.deepEqual(f.commands, [{ code: 'control', value: 'open' }, { code: 'control', value: 'stop' }]);
});

test('a physical stop clears a pending target and endpoint stale motion cannot keep Home moving', async t => {
  const f = tracking(t);
  await f.send('target/set', '75');
  f.reading(30, 'opening'); await f.tick();
  f.reading(35, 'stop'); await f.tick();
  assert.equal(f.state.target, 35);
  assert.equal(f.state.positionState, 'STOPPED');
  f.reading(100, 'opening'); await f.refresh();
  assert.equal(f.state.target, 100);
  assert.equal(f.state.positionState, 'STOPPED');
  assert.equal(f.commands.length, 1, 'Reading an endpoint never sends an unsolicited STOP');
});

test('external motion starts bounded fast polling and ignores a stale target behind the movement', async t => {
  const f = tracking(t);
  await f.refresh();
  assert.equal(f.state.target, 100, 'Opening with stale zero target uses the open endpoint');
  for (let i = 0; i < 60; i++) await f.tick();
  assert.equal(f.polls(), 61);
  await f.tick(59_000);
  assert.equal(f.polls(), 61, 'A stuck work_state does not cause endless fast polling');
  await f.tick();
  assert.equal(f.polls(), 62);
  assert.equal(f.commands.length, 0, 'Discovery and movement tracking never move a motor');
});


test('an end stop clears an overshot intermediate target even with stale motion feedback', async t => {
  const f = tracking(t);
  await f.send('target/set', '75');
  f.reading(50, 'opening'); await f.tick();
  assert.equal(f.state.target, 75);
  f.reading(100, 'opening'); await f.tick();
  assert.equal(f.state.target, 100);
  assert.equal(f.state.positionState, 'STOPPED');
  assert.equal(f.state.movingUntil, 0);
  assert.equal(f.commands.length, 1);
});
