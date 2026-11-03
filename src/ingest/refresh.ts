import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config/env.ts';
import type { Db } from '../db/client.ts';
import { getMeta } from '../db/meta.ts';
import type { Logger } from '../logger.ts';
import { META_KEYS } from './schedule/import.ts';
import { refreshStations } from './stations.ts';

const IMPORT_SCRIPT = fileURLToPath(new URL('../../scripts/import-schedule.ts', import.meta.url));

/**
 * At startup and daily at SCHEDULE_REFRESH_TIME (UK time):
 * 1. Download the schedule extract if NWR_SCHEDULE_URL is set; otherwise the file in
 *    DATA_DIR is replaced by hand.
 * 2. Import it if it's newer than the last import (or nothing is imported yet), in a
 *    child process so the worker's other jobs keep running.
 * 3. Re-fetch Knowledgebase stations older than a week.
 */
export function startDailyRefresh(db: Db, config: Config, log: Logger) {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const scheduleNext = () => {
    if (stopped) return;
    const [h, m] = config.scheduleRefreshTime.split(':').map(Number) as [number, number];
    const next = new Date();
    next.setHours(h, m, 0, 0); // process TZ is Europe/London (config/env.ts)
    if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
    log.info({ next: next.toISOString() }, 'Next reference data refresh scheduled');
    timer = setTimeout(() => void runRefresh(db, config, log, true).finally(scheduleNext), next.getTime() - Date.now());
  };
  void runRefresh(db, config, log, false).finally(scheduleNext);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

let refreshing = false;

export async function runRefresh(db: Db, config: Config, log: Logger, download: boolean) {
  if (refreshing) return;
  refreshing = true;
  try {
    if (download) {
      if (config.rdm.schedule.url) await downloadSchedule(config, log);
      else log.info('Refresh: NWR_SCHEDULE_URL not set; replace the schedule file in DATA_DIR by hand');
    }
    if (await needsImport(db, config, log)) await runImportProcess(config.scheduleFile, log);
    await refreshStations(db, config, (msg) => log.info(msg));
  } catch (err) {
    log.error({ err }, 'Refresh failed');
  } finally {
    refreshing = false;
  }
}

async function needsImport(db: Db, config: Config, log: Logger) {
  const importedAt = await getMeta(db, META_KEYS.importedAt);
  if (!fs.existsSync(config.scheduleFile)) {
    if (!importedAt) log.warn({ file: config.scheduleFile }, 'No timetable imported and no schedule file found');
    return false;
  }
  return !importedAt || fs.statSync(config.scheduleFile).mtime > new Date(importedAt);
}

function runImportProcess(file: string, log: Logger) {
  log.info({ file }, 'Refresh: importing schedule in a child process');
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [IMPORT_SCRIPT, file], { stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`schedule import exited with ${code}`))));
  });
}

async function downloadSchedule(config: Config, log: Logger) {
  const { url, key, username, password } = config.rdm.schedule;
  const headers: Record<string, string> = {};
  if (key) headers[config.rdm.authHeader] = key;
  if (username) headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  log.info('Refresh: downloading schedule');
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Schedule download failed: HTTP ${res.status}`);
  fs.mkdirSync(config.dataDir, { recursive: true });
  const part = `${config.scheduleFile}.part`;
  await pipeline(Readable.fromWeb(res.body as WebReadableStream), fs.createWriteStream(part));
  fs.renameSync(part, config.scheduleFile);
}
