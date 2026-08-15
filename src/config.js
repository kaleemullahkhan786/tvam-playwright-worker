/**
 * Worker configuration loaded from environment variables.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(workerRoot, '.env') });

function required(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return String(value).trim();
}

function bool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function int(name, fallback) {
  const raw = process.env[name];
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  apiBaseUrl: required('TVAM_API_BASE_URL').replace(/\/$/, ''),
  apiKey: required('TVAM_API_KEY'),
  pollIntervalMs: int('TVAM_POLL_INTERVAL_MS', 5000),
  jobLimit: int('TVAM_JOB_LIMIT', 3),
  storageStatePath: (() => {
    const raw = process.env.TVAM_STORAGE_STATE || './storage/storageState.json';
    return path.isAbsolute(raw) ? raw : path.resolve(workerRoot, raw);
  })(),
  headless: bool('TVAM_HEADLESS', true),
  actionDelayMs: int('TVAM_ACTION_DELAY_MS', 1500),
  workerRetries: int('TVAM_WORKER_RETRIES', 2),
  workerRoot,
};
