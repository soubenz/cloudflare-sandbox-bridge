import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface StoredSession {
  id: string;
  token: string;
  baseUrl: string;
}

const DIR = join(homedir(), '.opalix');
const FILE = join(DIR, 'session.json');

export function saveSession(session: StoredSession): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(session, null, 2));
}

export function loadSession(): StoredSession | undefined {
  if (!existsSync(FILE)) return undefined;
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return undefined;
  }
}

export function clearSession(): void {
  if (existsSync(FILE)) writeFileSync(FILE, '{}');
}
