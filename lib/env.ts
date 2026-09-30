/**
 * Configuration from `agent-kit/.env` (see `.env.example`). The process environment wins over
 * the file, so a deployment can set everything without one. Values are never printed.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ENV_FILES = [join(ROOT, '.env')];

/** Minimal .env reader: `KEY=value` lines, `#` comments, surrounding quotes stripped. Never overrides. */
export function loadEnv(files: string[] = ENV_FILES, env: NodeJS.ProcessEnv = process.env): void {
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && env[m[1]!] === undefined) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
    }
  }
}

export function must(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set — add it to .env (see .env.example)`);
  return v;
}
