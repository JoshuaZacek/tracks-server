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

/**
 * Reads the Darwin Push Port topic. Each Kafka batch is parsed, written in
 * chunks, handed to the journey updater, and only then committed, so a
 * restart resumes after the last stored message and never skips one.
 * On first start (no committed offset) it reads everything the topic still
 * holds, which warms up today's state.
 */
export async function startDarwinConsumer(opts: DarwinConsumerOptions) {
  const { db, config, log, lookups } = opts;
  const settings = config.rdm.darwin;
  const kafka = createKafka(settings, 'Darwin');
  const feed: FeedState = (await readFeedState(db)) ?? { lastMessageAt: new Date(0).toISOString(), lagSeconds: 0, gapAt: null };
  let lastRecorded = 0;
  let lastSequence: number | null = null;
  let lastMessageAtMs = 0;

  // Missed messages while we were down? (committed offset older than the oldest one retained)
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
      log.warn({ committed, oldestRetained: low.toString() }, 'Darwin: messages were missed while the worker was down (retention overrun)');
    }
    log.info({ committed: committed ?? 'none', low: low.toString(), high: topicOffsets[0]?.high }, 'Darwin: topic position');
  } catch (err) {
    log.warn({ err }, 'Darwin: could not check offsets for gaps');
  } finally {
    await admin.disconnect().catch(() => {});
  }

  const consumer = kafka.consumer({ groupId: settings.groupId, maxWaitTimeInMs: 1000 });
  await consumer.connect();
  await consumer.subscribe({ topic: settings.topic, fromBeginning: true });

  await consumer.run({
    autoCommit: false,
    eachBatchAutoResolve: false,
    eachBatch: async ({ batch, resolveOffset, heartbeat, isRunning, isStale }) => {
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
        feed.lastMessageAt = new Date(now).toISOString();
        feed.lagSeconds = chunk.lastKafkaTimestamp ? Math.max(0, Math.round((now - chunk.lastKafkaTimestamp) / 100) / 10) : feed.lagSeconds;
        if (feed.gapAt && now - Date.parse(feed.gapAt) > 24 * 3600_000) feed.gapAt = null;
        if (now - lastRecorded > FEED_RECORD_MS) {
          await recordFeed(db, feed);
          lastRecorded = now;
        }
        resolveOffset(lastOffset);
        await consumer.commitOffsets([{ topic: batch.topic, partition: batch.partition, offset: (BigInt(lastOffset) + 1n).toString() }]);
        await heartbeat();
        chunk = new DarwinBatch();
        chunk.lastSequence = lastSequence;
      };

      chunk.lastSequence = lastSequence;
      for (const message of batch.messages) {
        if (!isRunning() || isStale()) break;
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
    },
  });
  log.info({ topic: settings.topic }, 'Darwin consumer running');

  return {
    /** For the worker's own staleness decisions. */
    healthy: () => Date.now() - lastMessageAtMs < FEED_HEALTHY_MS,
    stop: async () => {
      await consumer.disconnect();
      await recordFeed(db, feed).catch(() => {});
    },
  };
}
