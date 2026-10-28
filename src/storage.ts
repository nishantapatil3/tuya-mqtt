import { mkdir, writeFile, rename, readFile, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sessionSchema, SharingCloud, type SharingSession } from './sharing.js';

export async function savePrivate(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await chmod(temp, 0o600); await rename(temp, path);
}
export function sharingSessionPath(configPath: string) {
  return process.env.TUYA_MQTT_SESSION ?? join(dirname(configPath), 'sharing-session.json');
}
export async function loadSharing(configPath: string) {
  const path = sharingSessionPath(configPath);
  const session = sessionSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  return new SharingCloud(session, (next: SharingSession) => savePrivate(path, next));
}
