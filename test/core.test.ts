import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { configSchema, blindSchema } from '../src/config.js';
import { signature, TuyaCloud } from '../src/cloud.js';
import { toHome, toTuya, observed, validateMapping, mqttthing, suggestDevice } from '../src/blind.js';
import { readFile } from 'node:fs/promises';
import { isLocalHost } from '../src/web-access.js';

const sample = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
const blind = blindSchema.parse(sample.devices[0]);
const cloudConfig = { region: 'us' as const, accessId: 'client-id', accessSecret: 'secret' };
test('setup accepts local addresses and rejects public hostnames and addresses', () => {
  for (const host of ['localhost:3200', '127.0.0.1:3200', '[::1]:3200', 'rpi.local:3200', '10.0.0.3:3200', '172.16.0.3', '192.168.1.3']) assert.equal(isLocalHost(host), true, host);
  for (const host of ['evil.example', '8.8.8.8', '172.32.0.1', '', 'localhost.evil.example']) assert.equal(isLocalHost(host), false, host);
});
function reply(result: unknown, success = true, code?: number) { return Response.json({ success, result, code, msg: 'rejected' }); }

test('configuration rejects collisions, wildcard topics, invalid URLs and zero polling', () => {
  assert.throws(() => configSchema.parse({ ...sample, pollIntervalSeconds: 0 }));
  assert.throws(() => configSchema.parse({ ...sample, motionPollSeconds: 0 }));
  assert.equal(configSchema.parse({ ...sample, motionPollSeconds: undefined }).motionPollSeconds, 1);
  assert.throws(() => configSchema.parse({ ...sample, devices: [sample.devices[0], sample.devices[0]] }));
  assert.throws(() => configSchema.parse({ ...sample, topicPrefix: 'tuya/+' }));
  assert.throws(() => configSchema.parse({ ...sample, mqttUrl: 'https://broker' }));
});
test('configuration accepts legacy and explicit blinds and rejects unsupported device types', () => {
  for (const type of [undefined, 'blind']) {
    const config = configSchema.parse({ ...sample, devices: [{ id: 'blind', name: 'Blind', type }] });
    assert.equal(config.devices[0]?.type, 'blind');
    assert.equal(mqttthing(config)[0]?.type, 'windowCovering');
  }
  for (const type of ['wateringPump', 'unknown']) {
    assert.throws(() => configSchema.parse({ ...sample, devices: [{ id: 'device', name: 'Device', type }] }));
  }
});
test('discovery suggests only supported window blinds with valid mappings', () => {
  const spec = { functions: [
    { code: 'percent_control', type: 'Integer', values: '{"min":0,"max":100,"step":1}' },
    { code: 'control', type: 'Enum', values: '{"range":["open","close","stop"]}' }
  ], status: [{ code: 'percent_state', type: 'Integer', values: '{}' }] };
  const device = { id: 'device', name: 'Device', online: true, status: [] };
  for (const category of ['cl', 'clkg']) {
    assert.equal(suggestDevice({ ...device, category }, spec)?.type, 'blind');
    assert.equal(suggestDevice({ ...device, category }, { ...spec, status: [] }), undefined);
  }
  const switchSpec = { functions: [{ code: 'switch', type: 'Boolean', values: '{}' }],
    status: [{ code: 'switch', type: 'Boolean', values: '{}' }] };
  assert.equal(suggestDevice({ ...device, category: 'ggq' }, switchSpec), undefined);
  assert.equal(suggestDevice({ ...device, category: 'ggq' }, spec), undefined);
});
test('percentage conversion supports inversion, strings and nonstandard ranges', () => {
  assert.equal(toHome(25, blind), 25);
  const inverted = { ...blind, invertPosition: true };
  assert.equal(toHome(0, inverted), 100);
  assert.equal(toTuya(100, inverted), 0);
  const wide = { ...blind, positionMin: 100, positionMax: 1100 };
  assert.equal(toHome('600', wide), 50);
  assert.equal(toTuya(50, { ...wide, targetAsString: true }), '600');
  for (const value of [null, true, {}, '', 'garbage', -1, 101]) assert.equal(toHome(value, blind), undefined);
  for (const value of [-1, 101, NaN, 2.3]) assert.throws(() => toTuya(value, blind));
});
test('motion is based on measured position or an explicit work-state mapping', () => {
  assert.deepEqual(observed([{ code: 'percent_state', value: 25 }], blind, 10), { current: 25, target: undefined, state: 'INCREASING' });
  assert.equal(observed([{ code: 'percent_state', value: 25 }], blind, 25).state, 'STOPPED');
  assert.equal(observed([{ code: 'work_state', value: 'closing' }], { ...blind, workStateCode: 'work_state' }).state, 'DECREASING');
  assert.equal(observed([], blind).current, undefined);
});
test('mqttthing availability handles bridge crashes and individual offline blinds without leaking passwords', () => {
  const config = configSchema.parse({ ...sample, mqttUrl: 'mqtt://user:secret@localhost:1883' });
  const exported = mqttthing(config)[0]!;
  assert.ok(!JSON.stringify(exported).includes('secret'));
  const online = new Function('message', exported.topics.getOnline.apply);
  assert.equal(online(JSON.stringify({ online: false, devices: {} })), 'offline');
  assert.equal(online(JSON.stringify({ online: true, devices: { [blind.id]: true } })), 'online');
  assert.equal(online(JSON.stringify({ online: true, devices: { [blind.id]: false } })), 'offline');
});
test('canonical signature includes blank headers, empty-body hash, query, token and timestamp', () => {
  const canonical = 'GET\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n\n/v1.0/token?grant_type=1';
  const expected = createHmac('sha256', 'secret').update('client-id1700000000000' + canonical).digest('hex').toUpperCase();
  assert.equal(signature('secret', 'client-id', '', '1700000000000', 'GET', '/v1.0/token?grant_type=1'), expected);
  assert.notEqual(signature('secret', 'client-id', 'access', '1700000000000', 'GET', '/v1.0/token?grant_type=1'), expected);
});
test('concurrent reads share token acquisition and authenticate requests', async () => {
  const calls: { url: string; headers: Headers }[] = [];
  const fake = (async (url, options) => {
    calls.push({ url: String(url), headers: new Headers(options?.headers) });
    if (String(url).includes('/token?')) { await new Promise(r => setTimeout(r, 10)); return reply({ access_token: 'access', expire_time: 7200 }); }
    return reply({ id: 'blind', online: true, status: [] });
  }) as typeof fetch;
  const cloud = new TuyaCloud(cloudConfig, fake);
  await Promise.all([cloud.device('a'), cloud.device('b')]);
  assert.equal(calls.filter(c => c.url.includes('/token?')).length, 1);
  assert.equal(calls[0]!.headers.has('access_token'), false);
  assert.equal(calls[1]!.headers.get('access_token'), 'access');
});
test('explicit expired-token errors renew once and retry once', async () => {
  let tokens = 0, reads = 0;
  const cloud = new TuyaCloud(cloudConfig, (async url => {
    if (String(url).includes('/token?')) return reply({ access_token: `t${++tokens}`, expire_time: 7200 });
    return ++reads === 1 ? reply(null, false, 1010) : reply({ id: 'a' });
  }) as typeof fetch);
  await cloud.device('a');
  assert.equal(tokens, 2); assert.equal(reads, 2);
});
test('ambiguous command failures are never automatically replayed', async () => {
  let commands = 0;
  const cloud = new TuyaCloud(cloudConfig, (async url => {
    if (String(url).includes('/token?')) return reply({ access_token: 'access', expire_time: 7200 });
    commands++; throw new Error('network timeout');
  }) as typeof fetch);
  await assert.rejects(cloud.command('blind', 'control', 'stop'), /connection failed/);
  assert.equal(commands, 1);
});
test('a false command result is not treated as success', async () => {
  const cloud = new TuyaCloud(cloudConfig, (async url => String(url).includes('/token?') ? reply({ access_token: 'access', expire_time: 7200 }) : reply(false)) as typeof fetch);
  await assert.rejects(cloud.command('blind', 'control', 'stop'), /did not accept/);
});
test('mapping rejects missing real position feedback and unsupported stop values', () => {
  const spec = { functions: [
    { code: 'percent_control', type: 'Integer', values: '{"min":0,"max":100,"step":1}' },
    { code: 'control', type: 'Enum', values: '{"range":["open","close","stop"]}' }
  ], status: [{ code: 'percent_state', type: 'Integer', values: '{}' }] };
  assert.doesNotThrow(() => validateMapping(blind, spec));
  assert.throws(() => validateMapping(blind, { ...spec, status: [] }));
  assert.throws(() => validateMapping({ ...blind, stopValue: 'pause' }, spec));
});
