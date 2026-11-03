import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config/env.ts';
import type { Db } from '../db/client.ts';
import { createLogger } from '../logger.ts';
import type { Lookups } from '../live/lookups.ts';
import type * as Store from './store.ts';

/** A stand-in for kafkajs: each consumer records what was done to it and can be made to crash. */
class FakeConsumer {
  events = { CRASH: 'consumer.crash' };
  crashHandler: ((e: { payload: { error: Error; restart: boolean; groupId: string } }) => void) | null = null;
  eachBatch: ((args: unknown) => Promise<void>) | null = null;
  disconnected = false;
  commits: string[] = [];
  on(_event: string, fn: NonNullable<FakeConsumer['crashHandler']>) {
    this.crashHandler = fn;
  }
  async connect() {}
  async subscribe() {}
  async run(cfg: { eachBatch: (args: unknown) => Promise<void> }) {
    this.eachBatch = cfg.eachBatch;
  }
  async disconnect() {
    this.disconnected = true;
  }
  async commitOffsets(offsets: { offset: string }[]) {
    this.commits.push(offsets[0]!.offset);
  }
  crash(restart: boolean) {
    this.crashHandler?.({ payload: { error: new Error('The coordinator is not aware of this member'), restart, groupId: 'g' } });
  }
  /** Delivers one heartbeat message, as the topic does every few seconds. */
  async heartbeatBatch(offset: string) {
    const value = JSON.stringify({ bytes: JSON.stringify({ ts: new Date().toISOString(), FailureResp: { code: 'HBOK' } }), properties: {} });
    await this.eachBatch!({
      batch: { topic: 't', partition: 0, messages: [{ offset, value: Buffer.from(value), timestamp: String(Date.now()) }] },
      resolveOffset: () => {},
      heartbeat: async () => {},
      isRunning: () => true,
      isStale: () => false,
    });
  }
}

const consumers: FakeConsumer[] = [];
vi.mock('../rdm/kafka.ts', () => ({
  createKafka: () => ({
    admin: () => ({
      connect: async () => {},
      disconnect: async () => {},
      fetchTopicOffsets: async () => [{ low: '0', high: '10' }],
      fetchOffsets: async () => [{ partitions: [{ offset: '5' }] }],
    }),
    consumer: () => {
      const c = new FakeConsumer();
      consumers.push(c);
      return c;
    },
  }),
}));
vi.mock('./store.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof Store>()),
  readFeedState: async () => null,
  recordFeed: async () => {},
  flushBatch: async () => {},
}));

const { startDarwinConsumer, STALL_MS } = await import('./consumer.ts');

const config = loadConfig();
const lookups = { ready: async () => lookups, crsOf: () => null } as unknown as Lookups;
let flushed = 0;
const start = () =>
  startDarwinConsumer({
    db: {} as Db,
    config,
    log: createLogger({ ...config, logLevel: 'silent' }, 'test'),
    lookups,
    onFlushed: async () => {
      flushed++;
    },
  });

beforeEach(() => {
  consumers.length = 0;
  flushed = 0;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('Darwin consumer', () => {
  it('stores, hands on and commits each batch, and reports healthy', async () => {
    const c = await start();
    expect(c.healthy()).toBe(false);
    await consumers[0]!.heartbeatBatch('41');
    expect(flushed).toBe(1);
    expect(consumers[0]!.commits).toEqual(['42']);
    expect(c.healthy()).toBe(true);
    await c.stop();
  });

  it('starts a fresh consumer after kafkajs gives up (non-retriable crash), after a backoff', async () => {
    const c = await start();
    consumers[0]!.crash(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(consumers[0]!.disconnected).toBe(true);
    expect(consumers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(consumers).toHaveLength(2);
    await consumers[1]!.heartbeatBatch('43');
    expect(consumers[1]!.commits).toEqual(['44']);
    await c.stop();
  });

  it('leaves crashes kafkajs retries by itself alone', async () => {
    const c = await start();
    consumers[0]!.crash(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(consumers).toHaveLength(1);
    expect(consumers[0]!.disconnected).toBe(false);
    await c.stop();
  });

  it('restarts a consumer that has gone quiet (no batches, not even heartbeats)', async () => {
    const c = await start();
    await vi.advanceTimersByTimeAsync(STALL_MS + 30_000 + 5_000);
    expect(consumers[0]!.disconnected).toBe(true);
    expect(consumers).toHaveLength(2);
    await c.stop();
  });

  it('does not restart once stopped, even mid-backoff', async () => {
    const c = await start();
    consumers[0]!.crash(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await c.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(consumers).toHaveLength(1);
  });
});
