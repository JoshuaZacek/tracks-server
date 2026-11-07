/**
 * Darwin spike: reads Darwin Push Port messages the topic still holds and saves examples as darwin-<kind>.json
 * (up to --per-kind of each element kind), so the parser is written against the real format, plus
 * darwin-raw-messages.json (a few whole messages) and darwin-stats.json (rates and sizes). They go to
 * data/darwin-capture/ (not committed) unless --out says otherwise: the parser tests read curated fixtures in
 * docs/samples/, so copy what is worth keeping there by hand rather than capturing over them.
 *
 *   npm run capture:darwin [-- --seconds 180] [-- --from-start] [-- --max 50000] [-- --per-kind 8] [-- --out dir]
 *
 * By default it reads the last --seconds of the topic (from the offset at that time, found with ListOffsets,
 * up to the newest message when it starts); --from-start reads everything retained, from the low watermark.
 *
 * Safe to run while the production worker is consuming: RDM authorises only the subscription's one consumer
 * group, and joining it would take the topic's single partition away from the worker. So this never joins a
 * group and never commits anything: it sends plain Fetch requests (as a consumer outside any group,
 * replicaId -1) to the partition leader. kafkajs has no public API for that, so it uses kafkajs's private
 * cluster (the `private:Kafka:createCluster` symbol); a kafkajs upgrade that changes it fails loudly here.
 *
 * Every file is checked for configured secrets before it is written.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Kafka } from 'kafkajs';
import { loadConfig, secretsOf } from '../src/config/env.ts';
import { createKafka } from '../src/rdm/kafka.ts';

const argText = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const arg = (name: string, fallback: number) => {
  const v = argText(name);
  return v === undefined ? fallback : Number(v);
};
const SECONDS = arg('seconds', 180);
const FROM_START = process.argv.includes('--from-start');
const MAX_MESSAGES = arg('max', 50_000);
const RAW_KEEP = 8;
const PER_KIND = arg('per-kind', 8);
const FETCH_MAX_BYTES = 8 * 1024 * 1024;

const config = loadConfig();
const secrets = secretsOf(config);
const settings = config.rdm.darwin;
const outArg = argText('out');
const outDir = outArg ? path.resolve(outArg) : fileURLToPath(new URL('../data/darwin-capture/', import.meta.url));
fs.mkdirSync(outDir, { recursive: true });

function save(name: string, data: unknown) {
  const text = JSON.stringify(data, null, 2);
  for (const s of secrets) if (text.includes(s)) throw new Error(`Refusing to write ${name}: it contains a configured secret`);
  fs.writeFileSync(path.join(outDir, name), text + '\n');
  console.log(`  saved ${path.join(outDir, name)} (${(text.length / 1024).toFixed(0)} KB)`);
}

const tryJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/**
 * Darwin Push Port messages are a Pport document with one update (uR) or snapshot (sR) block holding
 * element kinds (schedule, TS, deactivated, OW, …). The RDM envelope carries it as a JSON string in
 * `bytes`; this finds the Pport body wherever it is, in case the envelope changes.
 */
function findPport(value: unknown, depth = 0): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  const obj = value as Record<string, unknown>;
  if ('uR' in obj || 'sR' in obj) return obj;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'Pport' && v && typeof v === 'object') return v as Record<string, unknown>;
    const inner = typeof v === 'string' && v.trimStart().startsWith('{') ? tryJson(v) : v;
    const found = findPport(inner, depth + 1);
    if (found) return found;
  }
  return null;
}

/** The parts of kafkajs's private cluster and broker this uses. */
interface FetchedMessage {
  offset: string;
  timestamp: string;
  key: Buffer | null;
  value: Buffer | null;
  headers?: Record<string, unknown>;
}
interface Broker {
  fetch(request: {
    replicaId: number;
    isolationLevel: number;
    maxWaitTime: number;
    topics: { topic: string; partitions: { partition: number; fetchOffset: string; maxBytes: number }[] }[];
  }): Promise<{ responses: { partitions: { partition: number; messages: FetchedMessage[] }[] }[] }>;
}
interface Cluster {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  addTargetTopic(topic: string): Promise<void>;
  findLeaderForPartitions(topic: string, partitions: number[]): Record<string, number[]>;
  findBroker(target: { nodeId: string }): Promise<Broker>;
}

/** A cluster connection that belongs to no consumer group. */
function groupLessCluster(kafka: Kafka): Cluster {
  const symbol = Object.getOwnPropertySymbols(kafka).find((s) => s.description === 'private:Kafka:createCluster');
  const create = symbol ? (kafka as unknown as Record<symbol, unknown>)[symbol] : undefined;
  if (typeof create !== 'function') throw new Error('kafkajs internals changed: no private:Kafka:createCluster, so group-less fetching is unavailable');
  return (create as (opts: object) => Cluster).call(kafka, {});
}

const kafka = createKafka(settings, 'Darwin', 'tracks-server-capture');

console.log(`Connecting to Darwin (topic ${settings.topic}), without a consumer group`);
const admin = kafka.admin();
await admin.connect();
const watermarks = await admin.fetchTopicOffsets(settings.topic);
const since = FROM_START ? null : Date.now() - SECONDS * 1000;
const atSince = since === null ? [] : await admin.fetchTopicOffsetsByTimestamp(settings.topic, since);
await admin.disconnect();

/** Per partition: read [from, to), `to` being the high watermark when we started. */
const ranges = watermarks.map((w) => {
  const low = BigInt(w.low);
  const high = BigInt(w.high);
  const found = atSince.find((o) => o.partition === w.partition)?.offset;
  // ListOffsets answers -1 when no message is that recent.
  let from = since === null || found === undefined ? low : BigInt(found) < 0n ? high : BigInt(found);
  if (from < low) from = low;
  return { partition: w.partition, low, high, from };
});
const topicOffsets = ranges.map((r) => ({ partition: r.partition, low: r.low.toString(), high: r.high.toString(), from: r.from.toString() }));
console.log(`  ${ranges.length} partition(s): ${topicOffsets.map((r) => `#${r.partition} ${r.from}..${r.high} (low ${r.low})`).join(', ')}`);

const raw: unknown[] = [];
const byKind = new Map<string, unknown[]>();
const kindCounts = new Map<string, number>();
const perSecond = new Map<number, number>();
const stats = { messages: 0, bytes: 0, maxBytes: 0, unparsed: 0, firstAt: '', lastAt: '' };

function record(partition: number, message: FetchedMessage) {
  const text = message.value?.toString('utf8') ?? '';
  const ts = Number(message.timestamp);
  stats.messages++;
  stats.bytes += text.length;
  stats.maxBytes = Math.max(stats.maxBytes, text.length);
  const second = Math.floor(ts / 1000);
  perSecond.set(second, (perSecond.get(second) ?? 0) + 1);
  stats.firstAt ||= new Date(ts).toISOString();
  stats.lastAt = new Date(ts).toISOString();

  const value = tryJson(text);
  if (raw.length < RAW_KEEP) {
    raw.push({
      partition,
      offset: message.offset,
      key: message.key?.toString('utf8') ?? null,
      headers: Object.fromEntries(Object.entries(message.headers ?? {}).map(([k, v]) => [k, String(v)])),
      timestamp: new Date(ts).toISOString(),
      value,
    });
  }
  const pport = findPport(value);
  if (!pport) {
    stats.unparsed++;
    return;
  }
  const block = (pport.uR ?? pport.sR) as Record<string, unknown> | undefined;
  for (const [kind, items] of Object.entries(block ?? {})) {
    if (kind.startsWith('@') || kind.startsWith('$') || typeof items !== 'object' || items === null) continue;
    const list = Array.isArray(items) ? items : [items];
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + list.length);
    const kept = byKind.get(kind) ?? [];
    for (const item of list) if (kept.length < PER_KIND) kept.push(item);
    byKind.set(kind, kept);
  }
}

const cluster = groupLessCluster(kafka);
await cluster.connect();
const started = Date.now();
try {
  await cluster.addTargetTopic(settings.topic);
  for (const range of ranges) {
    const leaders = cluster.findLeaderForPartitions(settings.topic, [range.partition]);
    const nodeId = Object.keys(leaders)[0];
    if (nodeId === undefined) throw new Error(`No leader for partition ${range.partition}`);
    const broker = await cluster.findBroker({ nodeId });
    let offset = range.from;
    while (offset < range.high && stats.messages < MAX_MESSAGES) {
      const res = await broker.fetch({
        replicaId: -1,
        isolationLevel: 1,
        maxWaitTime: 2000,
        topics: [{ topic: settings.topic, partitions: [{ partition: range.partition, fetchOffset: offset.toString(), maxBytes: FETCH_MAX_BYTES }] }],
      });
      const messages = res.responses[0]?.partitions[0]?.messages ?? [];
      // A batch can start before the offset asked for; nothing at all means the end (e.g. retention moved past it).
      const fresh = messages.filter((m) => BigInt(m.offset) >= offset && BigInt(m.offset) < range.high);
      if (!fresh.length) break;
      for (const m of fresh) {
        if (stats.messages >= MAX_MESSAGES) break;
        record(range.partition, m);
        offset = BigInt(m.offset) + 1n;
      }
      console.log(`  ${stats.messages} messages (partition ${range.partition} at ${offset})`);
    }
  }
} finally {
  await cluster.disconnect();
}

const spanSeconds = stats.firstAt ? Math.max(1, (Date.parse(stats.lastAt) - Date.parse(stats.firstAt)) / 1000) : 0;
const rates = [...perSecond.values()].sort((a, b) => a - b);
const summary = {
  capturedAt: new Date().toISOString(),
  mode: FROM_START ? 'from-start' : `last ${SECONDS} s`,
  readSeconds: Math.round((Date.now() - started) / 1000),
  messages: stats.messages,
  // By Kafka timestamp, over the span read.
  spanSeconds: Math.round(spanSeconds),
  messagesPerSecond: { mean: spanSeconds ? +(stats.messages / spanSeconds).toFixed(1) : 0, p95: rates[Math.floor(rates.length * 0.95)] ?? 0, max: rates.at(-1) ?? 0 },
  bytes: { total: stats.bytes, meanPerMessage: Math.round(stats.bytes / Math.max(1, stats.messages)), max: stats.maxBytes },
  unparsedMessages: stats.unparsed,
  elementCounts: Object.fromEntries([...kindCounts].sort((a, b) => b[1] - a[1])),
  firstMessageAt: stats.firstAt,
  lastMessageAt: stats.lastAt,
  topicOffsets,
};
console.log(JSON.stringify({ ...summary, topicOffsets: undefined }, null, 2));
save('darwin-raw-messages.json', raw);
for (const [kind, list] of byKind) save(`darwin-${kind.replace(/[^A-Za-z0-9_-]/g, '_')}.json`, list);
save('darwin-stats.json', summary);
process.exit(0);
