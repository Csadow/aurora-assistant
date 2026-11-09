import './environment.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const config = {
  timezone: process.env.AURORA_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  port: Number(process.env.AURORA_PORT || 4717),
  vault: process.env.AURORA_VAULT || join(homedir(), 'Documents', 'Aurora Memory'),
  data: process.env.AURORA_DATA || join(homedir(), '.local/share/aurora-assistant'),
  backups: process.env.AURORA_BACKUPS || join(homedir(), 'Documents', 'Aurora Backups'),
  desktopProfile: process.env.AURORA_DESKTOP_DATA || join(homedir(), '.config', 'aurora-assistant'),
  runtime: process.env.AURORA_AI_DIR || join(homedir(), '.local/share/aurora-assistant/ai'),
  ollama: process.env.AURORA_OLLAMA || 'http://127.0.0.1:11434',
  model: process.env.AURORA_MODEL || 'qwen3.5:4b',
  embedding: process.env.AURORA_EMBEDDING ?? 'embeddinggemma:latest',
  projects: [{name: 'Aurora', root: fileURLToPath(new URL('../', import.meta.url))}]
};
export function localEndpoint(value) {
  const u = new URL(value);
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('Ollama must use a local HTTP loopback address.');
  return u.origin;
}
