import type { Consumer, EachBatchHandler } from 'kafkajs';
import type { Config } from '../config/env.ts';
import type { Db } from '../db/client.ts';
import type { Logger } from '../logger.ts';
import type { Lookups } from '../live/lookups.ts';
import { createKafka } from '../rdm/kafka.ts';
import { parseMessage } from './parse.ts';
import { DarwinBatch, flushBatch, readFeedState, recordFeed, type FeedState } from './store.ts';

/** Write processed messages (and commit their offsets) at least every this many messages. */
const CHUNK = 2000;
/** Record feed liveness at most this often. */
const FEED_RECORD_MS = 5_000;
/** The feed counts as down after this long without any message (heartbeats arrive every few seconds). */
export const FEED_HEALTHY_MS = 5 * 60_000;

export interface DarwinConsumerOptions {
  db: Db;
  config: Config;
  log: Logger;
  lookups: Lookups;
  /** Called after each write with the runs it touched (journey updates). Errors are logged, not retried. */
  onFlushed: (touched: ReturnType<DarwinBatch['touched']>) => Promise<void>;
}

/** With no batch processed for this long (heartbeats arrive every few seconds), the consumer counts as stuck and is restarted. */
export const STALL_MS = 3 * 60_000;
const WATCHDOG_MS = 30_000;
const RESTART_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

/**
 * Reads the Darwin Push Port topic. Each Kafka batch is parsed, written in
 * chunks, handed to the journey updater, and only then committed, so a
 * restart resumes after the last stored message and never skips one.
 * On first start (no committed offset) it reads everything the topic still
 * holds, which warms up today's state.
 *
 * It looks after itself: kafkajs gives up on some errors (e.g. "the
 * coordinator is not aware of this member" after a long network outage) and
 * never restarts, so a crash it won't recover from, a failed start, or a
 * stall (nothing processed for STALL_MS) disconnects and starts a fresh
 * consumer after a backoff, resuming from the committed offset.
 */
export async function startDarwinConsumer(opts: DarwinConsumerOptions) {
  const { db, config, log, lookups } = opts;
  const settings = config.rdm.darwin;
  const kafka = createKafka(settings, 'Darwin');
  const feed: FeedState = (await readFeedState(db)) ?? { lastMessageAt: new Date(0).toISOString(), lagSeconds: 0, gapAt: null };
  let lastRecorded = 0;
  let lastSequence: number | null = null;
  let lastMessageAtMs = 0;
  /** Last sign of progress (a batch written, or a (re)start), for the watchdog. */
  let lastActivityMs = Date.now();
  let consumer: Consumer | null = null;
  let stopped = false;
  let restarting = false;
  let failures = 0;
  let wake: (() => void) | null = null;

  /** Missed messages while we weren't reading? (committed offset older than the oldest one retained) */
  async function checkForGap() {
    const admin = kafka.admin();
    try {
      await admin.connect();
      const [topicOffsets, groupOffsets] = await Promise.all([
        admin.fetchTopicOffsets(settings.topic),
        admin.fetchOffsets({ groupId: settings.groupId, topics: [settings.topic] }),
      ]);
      const low = BigInt(topicOffsets[0]?.low ?? '0');
      const committed = groupOffsets[0]?.partitions[0]?.offset;
      if (committed !== undefined && committed !== '-1' && BigInt(committed) < low) {
        feed.gapAt = new Date().toISOString();
        await recordFeed(db, feed);
        log.warn(
          { committed, oldestRetained: low.toString(), missed: (low - BigInt(committed)).toString() },
          'Darwin: messages were missed while not consuming (retention overrun)',
        );
      }
      log.info({ committed: committed ?? 'none', low: low.toString(), high: topicOffsets[0]?.high }, 'Darwin: topic position');
    } catch (err) {
      log.warn({ err }, 'Darwin: could not check offsets for gaps');
    } finally {
      await admin.disconnect().catch(() => {});
    }
  }

  function eachBatchFor(c: Consumer): EachBatchHandler {
    return async ({ batch, resolveOffset, heartbeat, isRunning, isStale }) => {
      let chunk = new DarwinBatch();
      let lastOffset: string | null = null;

      const write = async () => {
        if (lastOffset === null) return;
        await lookups.ready();
        await flushBatch(db, chunk, lookups.crsOf);
        try {
          await opts.onFlushed(chunk.touched());
        } catch (err) {
          log.error({ err }, 'Darwin: journey update failed (the clock tick will retry)');
        }
        if (chunk.sequenceGaps) {
          feed.gapAt = new Date().toISOString();
          log.warn({ gaps: chunk.sequenceGaps }, 'Darwin: sequence gap (messages missed upstream)');
        }
        const now = Date.now();
        lastMessageAtMs = now;
        lastActivityMs = now;
        failures = 0;
        feed.lastMessageAt = new Date(now).toISOString();
        feed.lagSeconds = chunk.lastKafkaTimestamp ? Math.max(0, Math.round((now - chunk.lastKafkaTimestamp) / 100) / 10) : feed.lagSeconds;
        if (feed.gapAt && now - Date.parse(feed.gapAt) > 24 * 3600_000) feed.gapAt = null;
        if (now - lastRecorded > FEED_RECORD_MS) {
          await recordFeed(db, feed);
          lastRecorded = now;
        }
        resolveOffset(lastOffset);
        await c.commitOffsets([{ topic: batch.topic, partition: batch.partition, offset: (BigInt(lastOffset) + 1n).toString() }]);
        await heartbeat();
        chunk = new DarwinBatch();
        chunk.lastSequence = lastSequence;
      };

      chunk.lastSequence = lastSequence;
      for (const message of batch.messages) {
        if (!isRunning() || isStale() || c !== consumer) break;
        if (message.value) {
          try {
            chunk.add(parseMessage(message.value), Number(message.timestamp));
          } catch (err) {
            log.warn({ err, offset: message.offset }, 'Darwin: unreadable message skipped');
          }
        }
        lastSequence = chunk.lastSequence;
        lastOffset = message.offset;
        if (chunk.messages >= CHUNK) await write();
      }
      await write();
    };
  }

  async function run() {
    await checkForGap();
    const c = kafka.consumer({ groupId: settings.groupId, maxWaitTimeInMs: 1000 });
    consumer = c;
    lastActivityMs = Date.now();
    c.on(c.events.CRASH, ({ payload }) => {
      // With restart=true kafkajs retries by itself; with false it has given up for good.
      if (!payload.restart && c === consumer) void restart(`crashed: ${payload.error.message}`);
    });
    await c.connect();
    await c.subscribe({ topic: settings.topic, fromBeginning: true });
    await c.run({ autoCommit: false, eachBatchAutoResolve: false, eachBatch: eachBatchFor(c) });
    log.info({ topic: settings.topic }, 'Darwin consumer running');
  }

  async function restart(reason: string) {
    if (stopped || restarting) return;
    restarting = true;
    const delay = RESTART_BACKOFF_MS[Math.min(failures++, RESTART_BACKOFF_MS.length - 1)]!;
    log.error({ reason, retryInSeconds: delay / 1000 }, 'Darwin consumer stopped; restarting');
    const old = consumer;
    consumer = null;
    await old?.disconnect().catch(() => {});
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    wake = null;
    restarting = false;
    if (stopped) return;
    try {
      await run();
    } catch (err) {
      void restart(`start failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const watchdog = setInterval(() => {
    if (!restarting && consumer && Date.now() - lastActivityMs > STALL_MS) {
      void restart(`nothing processed for ${Math.round((Date.now() - lastActivityMs) / 1000)} s`);
    }
  }, WATCHDOG_MS);
  watchdog.unref();

  try {
    await run();
  } catch (err) {
    void restart(`start failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    /** For the worker's own staleness decisions. */
    healthy: () => Date.now() - lastMessageAtMs < FEED_HEALTHY_MS,
    stop: async () => {
      stopped = true;
      clearInterval(watchdog);
      wake?.();
      const c = consumer;
      consumer = null;
      await c?.disconnect().catch(() => {});
      await recordFeed(db, feed).catch(() => {});
    },
  };
}
