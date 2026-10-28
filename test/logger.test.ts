import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/logger.js';

test('structured logs redact credentials, user codes, token paths and request errors', () => {
  const before = process.env.LOG_LEVEL; process.env.LOG_LEVEL = 'debug';
  try {
    const lines: string[] = [];
    const logger = createLogger('test', line => lines.push(line));
    logger.info('request', {
      access_token: 'secret-access', refreshToken: 'secret-refresh', accessSecret: 'secret-key',
      userCode: 'private-user-code', authorization: 'Bearer private-header',
      mqttUrl: 'mqtt://private-user:private-password@localhost:1883',
      path: '/v1.0/m/token/private-path-value',
      qrPath: '/v1.0/m/life/home-assistant/qrcode/tokens/private-qr-value',
      nested: { password: 'nested-password', value: 'ordinary-value' },
      error: new Error('https://private-user:private-password@example.com')
    });
    const text = lines[0]!;
    for (const secret of ['secret-access', 'secret-refresh', 'secret-key', 'private-user-code', 'private-header', 'private-user', 'private-password', 'private-path-value', 'private-qr-value', 'nested-password'])
      assert.ok(!text.includes(secret), secret);
    const log = JSON.parse(text);
    assert.equal(log.level, 'info'); assert.equal(log.scope, 'test');
    assert.ok(log.time); assert.equal(log.details.nested.value, 'ordinary-value');
  } finally { if (before === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = before; }
});
test('LOG_LEVEL filters debug and info while retaining errors', () => {
  const before = process.env.LOG_LEVEL; process.env.LOG_LEVEL = 'warn';
  try {
    const lines: string[] = [];
    const logger = createLogger('test', line => lines.push(line));
    logger.debug('debug'); logger.info('info'); logger.warn('warning'); logger.error('error');
    assert.deepEqual(lines.map(line => JSON.parse(line).level), ['warn', 'error']);
  } finally { if (before === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = before; }
});
