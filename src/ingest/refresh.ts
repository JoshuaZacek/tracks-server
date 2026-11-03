import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import type { Config } from '../config/env.ts';
import type { Db } from '../db/client.ts';
import { getMeta } from '../db/meta.ts';
import type { Logger } from '../logger.ts';
import { META_KEYS } from './schedule/import.ts';
import { refreshStations } from './stations.ts';

const IMPORT_SCRIPT = fileURLToPath(new URL('../../scripts/import-schedule.ts', import.meta.url));

/** A download that takes longer than this is abandoned (the file is ~140 MB). */
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
/** After a failed download, try again this often, this many times, before waiting for the next day. */
const RETRY_MS = 60 * 60_000;
const RETRIES = 5;
/** At startup, download unless the file on disk is younger than this. */
const STARTUP_DOWNLOAD_AGE_MS = 20 * 3600_000;

/**
 * At startup and daily at SCHEDULE_REFRESH_TIME (UK time):
 * 1. Download the schedule extract if NWR_SCHEDULE_URL is set (at startup only if the file
 *    is missing or older than 20 h). It is checked (a complete JsonTimetableV1 file, newer
 *    than the one imported) before it replaces the file in DATA_DIR. A failed download is
 *    retried hourly, 5 times. Without NWR_SCHEDULE_URL, the file is replaced by hand.
 * 2. Import it if it's newer than the last import (or nothing is imported yet), in a
 *    child process so the worker's other jobs keep running.
 * 3. Re-fetch Knowledgebase stations older than a week.
 */
export function startDailyRefresh(db: Db, config: Config, log: Logger) {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let retries = 0;
  const after = (result: RefreshResult) => {
    if (stopped) return;
    if (result.downloadFailed && retries < RETRIES) {
      retries++;
      log.warn({ retry: retries, of: RETRIES, inMinutes: RETRY_MS / 60_000 }, 'Refresh: timetable download will be retried');
      timer = setTimeout(() => void runRefresh(db, config, log, true).then(after), RETRY_MS);
      return;
    }
    retries = 0;
    const [h, m] = config.scheduleRefreshTime.split(':').map(Number) as [number, number];
    const next = new Date();
    next.setHours(h, m, 0, 0); // process TZ is Europe/London (config/env.ts)
    if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
    log.info({ next: next.toISOString() }, 'Next reference data refresh scheduled');
    timer = setTimeout(() => void runRefresh(db, config, log, true).then(after), next.getTime() - Date.now());
  };
  const stale = !fs.existsSync(config.scheduleFile) || Date.now() - fs.statSync(config.scheduleFile).mtimeMs > STARTUP_DOWNLOAD_AGE_MS;
  void runRefresh(db, config, log, stale).then(after);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export interface RefreshResult {
  downloadFailed: boolean;
}

let refreshing = false;

export async function runRefresh(db: Db, config: Config, log: Logger, download: boolean): Promise<RefreshResult> {
  if (refreshing) return { downloadFailed: false };
  refreshing = true;
  let downloadFailed = false;
  try {
    if (download) {
      if (config.rdm.schedule.url) {
        try {
          await downloadSchedule(db, config, log);
        } catch (err) {
          // Keep going: the current timetable stays, and stations still refresh.
          downloadFailed = true;
          log.error({ err }, 'Refresh: timetable download failed; keeping the current timetable');
        }
      } else {
        log.info('Refresh: NWR_SCHEDULE_URL not set; replace the schedule file in DATA_DIR by hand');
      }
    }
    if (await needsImport(db, config, log)) await runImportProcess(config.scheduleFile, log);
    await refreshStations(db, config, (msg) => log.info(msg));
  } catch (err) {
    log.error({ err }, 'Refresh failed');
  } finally {
    refreshing = false;
  }
  return { downloadFailed };
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

/**
 * Downloads the extract to a temporary file and only puts it in place if it is a complete
 * NWR timetable newer than the one imported. Credentials go to NWR_SCHEDULE_URL only:
 * fetch drops the Authorization header when a redirect leaves that origin (NROD redirects
 * to a pre-signed S3 URL, which would refuse it). Returns whether a new file was put in place.
 */
export async function downloadSchedule(db: Db, config: Config, log: Logger, timeoutMs = DOWNLOAD_TIMEOUT_MS): Promise<boolean> {
  const { url, key, username, password } = config.rdm.schedule;
  const headers: Record<string, string> = {};
  if (key) headers[config.rdm.authHeader] = key;
  if (username) headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  log.info('Refresh: downloading schedule');
  fs.mkdirSync(config.dataDir, { recursive: true });
  const part = `${config.scheduleFile}.part`;
  const started = Date.now();
  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok || !res.body) throw new Error(`Schedule download failed: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as WebReadableStream), fs.createWriteStream(part));
    const header = await inspectSchedule(part).catch((err: Error) => {
      throw new Error(`Downloaded file is not a usable timetable: ${err.message}`);
    });
    const current = await getMeta(db, META_KEYS.timestamp);
    const generated = new Date(header.timestamp * 1000);
    const bytes = fs.statSync(part).size;
    if (current && generated.getTime() <= Date.parse(current)) {
      log.info({ generated: generated.toISOString(), imported: current }, 'Refresh: no newer timetable than the one imported');
      return false;
    }
    fs.renameSync(part, config.scheduleFile);
    log.info({ generated: generated.toISOString(), sequence: header.sequence, mb: Math.round(bytes / 1e6), seconds: Math.round((Date.now() - started) / 1000) }, 'Refresh: downloaded a new timetable');
    return true;
  } finally {
    fs.rmSync(part, { force: true });
  }
}

/**
 * Checks a timetable file without importing it: gzip that decompresses to the end, a
 * JsonTimetableV1 header first and the EOF record last (so a cut-off download is caught).
 */
export async function inspectSchedule(file: string): Promise<{ timestamp: number; sequence: number | null }> {
  const raw = fs.createReadStream(file);
  const input = file.endsWith('.part') || file.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw;
  let header: { timestamp?: number; Metadata?: { sequence?: number } } | undefined;
  let last = '';
  let first = true;
  const errors = new Promise<never>((_, reject) => {
    raw.on('error', reject);
    input.on('error', reject);
  });
  const read = (async () => {
    for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
      if (first) {
        first = false;
        try {
          header = (JSON.parse(line) as { JsonTimetableV1?: typeof header }).JsonTimetableV1;
        } catch {
          header = undefined;
        }
        if (!header) throw new Error('no JsonTimetableV1 header on the first line');
      }
      if (line.trim()) last = line.trim();
    }
  })();
  await Promise.race([read, errors]);
  if (!header?.timestamp) throw new Error('no JsonTimetableV1 header with a timestamp');
  if (last !== '{"EOF":true}') throw new Error('the EOF record is missing (incomplete file)');
  return { timestamp: header.timestamp, sequence: header.Metadata?.sequence ?? null };
}
