import { isIP } from 'node:net';

export function isLocalHost(host: string) {
  let name: string;
  try { name = new URL(`http://${host}`).hostname.toLowerCase(); } catch { return false; }
  if (name === 'localhost' || name.endsWith('.local')) return true;
  const ip = name.replace(/^\[|\]$/g, '');
  if (isIP(ip) === 6) return ip === '::1' || /^(fc|fd|fe80:)/.test(ip);
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b! >= 16 && b! <= 31);
}
