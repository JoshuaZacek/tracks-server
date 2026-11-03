import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config/env.ts';
import type { Db } from '../db/client.ts';
import { createLogger } from '../logger.ts';
import type * as Meta from '../db/meta.ts';

/** The imported timetable's timestamp, as meta would hold it. */
let importedTimestamp: string | null = null;
vi.mock('../db/meta.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof Meta>()),
  getMeta: async () => importedTimestamp,
}));
const { downloadSchedule, inspectSchedule } = await import('./refresh.ts');

const header = (timestamp: number) => JSON.stringify({ JsonTimetableV1: { timestamp, Metadata: { type: 'full', sequence: 5300 } } });
const timetable = (timestamp: number, { eof = true } = {}) =>
  zlib.gzipSync([header(timestamp), '{"TiplocV1":{"tiploc_code":"KNGX"}}', ...(eof ? ['{"EOF":true}'] : []), ''].join('\n'));

/**
 * NROD stand-in: checks Basic auth and redirects to "S3", a server on another origin
 * (another port), which serves whatever `s3Body` is and records the headers it got.
 */
let s3Body: Buffer | string = '';
let s3Headers: http.IncomingHttpHeaders = {};
let nrodAuth: string | undefined;
let stall = false;
const s3 = http.createServer((req, res) => {
  s3Headers = req.headers;
  if (stall) return res.writeHead(200).write('x'); // never ends
  res.writeHead(200).end(s3Body);
});
const nrod = http.createServer((req, res) => {
  nrodAuth = req.headers.authorization;
  if (req.headers.authorization !== `Basic ${Buffer.from('me@example.com:secret').toString('base64')}`) return res.writeHead(401).end();
  res.writeHead(302, { location: `http://127.0.0.1:${(s3.address() as AddressInfo).port}/signed?X-Amz-Signature=abc` }).end();
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracks-refresh-'));
const config = loadConfig({ ...process.env, DATA_DIR: dir, NWR_SCHEDULE_USERNAME: 'me@example.com', NWR_SCHEDULE_PASSWORD: 'secret' });
const log = createLogger({ ...config, logLevel: 'silent' }, 'test');
const db = {} as Db;
const existing = () => (fs.existsSync(config.scheduleFile) ? fs.readFileSync(config.scheduleFile) : null);

beforeAll(async () => {
  await new Promise<void>((r) => s3.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => nrod.listen(0, '127.0.0.1', r));
  config.rdm.schedule.url = `http://127.0.0.1:${(nrod.address() as AddressInfo).port}/ntrod/CifFileAuthenticate?type=CIF_ALL_FULL_DAILY&day=toc-full`;
});
beforeEach(() => {
  fs.rmSync(config.scheduleFile, { force: true });
  importedTimestamp = null;
  stall = false;
});
afterAll(async () => {
  s3.closeAllConnections();
  await new Promise((r) => s3.close(r));
  await new Promise((r) => nrod.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('timetable download', () => {
  it('logs in to NROD, follows the redirect without sending the credentials on, and puts the file in place', async () => {
    s3Body = timetable(1793750000);
    expect(await downloadSchedule(db, config, log)).toBe(true);
    expect(nrodAuth).toMatch(/^Basic /);
    expect(s3Headers.authorization).toBeUndefined();
    expect(existing()).toEqual(s3Body);
    expect(fs.existsSync(`${config.scheduleFile}.part`)).toBe(false);
  });

  it('keeps the current file when the download is not a timetable or is cut off', async () => {
    fs.writeFileSync(config.scheduleFile, 'current');
    for (const body of ['<html>Service unavailable</html>', zlib.gzipSync('<html>maintenance</html>'), timetable(1793750000, { eof: false })]) {
      s3Body = body;
      await expect(downloadSchedule(db, config, log)).rejects.toThrow(/not a usable timetable/);
      expect(existing()?.toString()).toBe('current');
      expect(fs.existsSync(`${config.scheduleFile}.part`)).toBe(false);
    }
  });

  it('does not replace the file with one no newer than the timetable already imported', async () => {
    fs.writeFileSync(config.scheduleFile, 'current');
    importedTimestamp = new Date(1793750000 * 1000).toISOString();
    s3Body = timetable(1793750000);
    expect(await downloadSchedule(db, config, log)).toBe(false);
    expect(existing()?.toString()).toBe('current');
    s3Body = timetable(1793750000 + 86400);
    expect(await downloadSchedule(db, config, log)).toBe(true);
  });

  it('fails on wrong credentials and on a stalled download', async () => {
    const wrong = loadConfig({ ...process.env, DATA_DIR: dir, NWR_SCHEDULE_USERNAME: 'me@example.com', NWR_SCHEDULE_PASSWORD: 'nope' });
    wrong.rdm.schedule.url = config.rdm.schedule.url;
    await expect(downloadSchedule(db, wrong, log)).rejects.toThrow(/HTTP 401/);
    stall = true;
    await expect(downloadSchedule(db, config, log, 300)).rejects.toThrow();
    expect(fs.existsSync(`${config.scheduleFile}.part`)).toBe(false);
  });
});

describe('inspectSchedule', () => {
  it('reads the header of a real-shaped file', async () => {
    const file = path.join(dir, 'check.json.gz');
    fs.writeFileSync(file, timetable(1791160298));
    expect(await inspectSchedule(file)).toEqual({ timestamp: 1791160298, sequence: 5300 });
  });
});
