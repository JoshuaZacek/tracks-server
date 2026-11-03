/**
 * Phase 0 spike: reads live Darwin Push Port messages and saves examples into
 * docs/samples/darwin-*.json so the parser is written against the real format,
 * plus docs/samples/darwin-stats.json with message rates and sizes.
 *
 *   npm run capture:darwin [-- --seconds 180] [-- --max 20000]
 *
 * Offsets are never committed, so this doesn't move the consumer group. Every
 * file is checked for configured secrets before it is written.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, secretsOf } from '../src/config/env.ts';
import { createKafka } from '../src/rdm/kafka.ts';

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const MAX_SECONDS = arg('seconds', 180);
const MAX_MESSAGES = arg('max', 50_000);
const RAW_KEEP = 8;
const PER_KIND = 8;

const config = loadConfig();
const secrets = secretsOf(config);
const settings = config.rdm.darwin;
const outDir = fileURLToPath(new URL('../docs/samples/', import.meta.url));
fs.mkdirSync(outDir, { recursive: true });

function save(name: string, data: unknown) {
  const text = JSON.stringify(data, null, 2);
  for (const s of secrets) if (text.includes(s)) throw new Error(`Refusing to write ${name}: it contains a configured secret`);
  fs.writeFileSync(path.join(outDir, name), text + '\n');
  console.log(`  saved docs/samples/${name} (${(text.length / 1024).toFixed(0)} KB)`);
}

const tryJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/**
 * Darwin Push Port messages are a Pport document with one update (uR) or
 * snapshot (sR) block holding arrays of element types (schedule, TS,
 * deactivated, OW, …). The JSON topic's envelope is unknown until we look, so
 * this finds the Pport body wherever it is and lists the element kinds in it.
 */
function findPport(value: unknown, depth = 0): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  const obj = value as Record<string, unknown>;
  if ('uR' in obj || 'sR' in obj) return obj;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'Pport' && v && typeof v === 'object') return v as Record<string, unknown>;
    // Some envelopes carry the payload as a JSON string (e.g. "bytes").
    const inner = typeof v === 'string' && v.trimStart().startsWith('{') ? tryJson(v) : v;
    const found = findPport(inner, depth + 1);
    if (found) return found;
  }
  return null;
}

const kafka = createKafka(settings, 'Darwin', 'tracks-server-capture');
const admin = kafka.admin();
const consumer = kafka.consumer({ groupId: settings.groupId });

const raw: unknown[] = [];
const byKind = new Map<string, unknown[]>();
const kindCounts = new Map<string, number>();
const perSecond = new Map<number, number>();
const stats = { messages: 0, bytes: 0, maxBytes: 0, unparsed: 0, firstAt: '', lastAt: '', lagSamplesMs: [] as number[] };

console.log(`Connecting to Darwin (topic ${settings.topic})`);
await admin.connect();
let offsets: unknown;
try {
  const now = await admin.fetchTopicOffsets(settings.topic);
  const dayAgo = await admin.fetchTopicOffsetsByTimestamp(settings.topic, Date.now() - 24 * 3600_000);
  offsets = { partitions: now.length, latest: now, atOneDayAgo: dayAgo };
  console.log(`  ${now.length} partition(s)`);
} catch (err) {
  offsets = { error: (err as Error).message };
  console.log(`  could not read topic offsets: ${(err as Error).message}`);
}
await admin.disconnect();

await consumer.connect();
await consumer.subscribe({ topic: settings.topic, fromBeginning: false });
const started = Date.now();

await new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, MAX_SECONDS * 1000);
  void consumer.run({
    autoCommit: false,
    eachMessage: async ({ message, partition }) => {
      const text = message.value?.toString('utf8') ?? '';
      const now = Date.now();
      stats.messages++;
      stats.bytes += text.length;
      stats.maxBytes = Math.max(stats.maxBytes, text.length);
      const second = Math.floor((now - started) / 1000);
      perSecond.set(second, (perSecond.get(second) ?? 0) + 1);
      const ts = Number(message.timestamp);
      if (stats.messages % 50 === 1) stats.lagSamplesMs.push(now - ts);
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
      if (stats.messages === 1) console.log('  receiving...');
      if (stats.messages % 2000 === 0) console.log(`  ${stats.messages} messages`);
      if (stats.messages >= MAX_MESSAGES) {
        clearTimeout(timer);
        resolve();
      }
    },
  });
});
await consumer.disconnect();

const seconds = (Date.now() - started) / 1000;
const rates = [...perSecond.values()].sort((a, b) => a - b);
const lags = stats.lagSamplesMs.sort((a, b) => a - b);
const summary = {
  capturedAt: new Date().toISOString(),
  seconds: Math.round(seconds),
  messages: stats.messages,
  messagesPerSecond: { mean: +(stats.messages / seconds).toFixed(1), p95: rates[Math.floor(rates.length * 0.95)] ?? 0, max: rates.at(-1) ?? 0 },
  bytes: { total: stats.bytes, meanPerMessage: Math.round(stats.bytes / Math.max(1, stats.messages)), max: stats.maxBytes },
  kafkaTimestampLagMs: { median: lags[Math.floor(lags.length / 2)] ?? null, max: lags.at(-1) ?? null },
  unparsedMessages: stats.unparsed,
  elementCounts: Object.fromEntries([...kindCounts].sort((a, b) => b[1] - a[1])),
  firstMessageAt: stats.firstAt,
  lastMessageAt: stats.lastAt,
  topicOffsets: offsets,
};
console.log(JSON.stringify({ ...summary, topicOffsets: undefined }, null, 2));
save('darwin-raw-messages.json', raw);
for (const [kind, list] of byKind) save(`darwin-${kind.replace(/[^A-Za-z0-9_-]/g, '_')}.json`, list);
save('darwin-stats.json', summary);
process.exit(0);
