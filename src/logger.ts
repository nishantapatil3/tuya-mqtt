type Fields = Record<string, unknown>;
const priorities = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
type Level = Exclude<keyof typeof priorities, 'silent'>;
const sensitive = /password|secret|token|authorization|cookie|user.?code|access.?id/i;
function scrub(text: string) {
  return text.replace(/(mqtts?:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/((?:usercode|access_token|refresh_token|token|password|secret)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(\/m\/token\/)[^/?\s]+/g, '$1[REDACTED]')
    .replace(/(\/qrcode\/tokens\/)[^/?\s]+/g, '$1[REDACTED]');
}
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return scrub(value);
  if (value instanceof Error) return { name: value.name }; // Request errors can embed credentials in their messages.
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => redact(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitive.test(key) ? '[REDACTED]' : redact(item, seen)]));
}
export function createLogger(scope: string, sink: (line: string) => void = console.log) {
  const configured = process.env.LOG_LEVEL ?? 'info';
  const threshold = priorities[configured as keyof typeof priorities] ?? priorities.info;
  const write = (level: Level, event: string, fields: Fields = {}) => {
    if (priorities[level] < threshold) return;
    sink(JSON.stringify({ time: new Date().toISOString(), level, scope, event: scrub(event), details: redact(fields) }));
  };
  return {
    debug: (event: string, fields?: Fields) => write('debug', event, fields),
    info: (event: string, fields?: Fields) => write('info', event, fields),
    warn: (event: string, fields?: Fields) => write('warn', event, fields),
    error: (event: string, fields?: Fields) => write('error', event, fields)
  };
}
