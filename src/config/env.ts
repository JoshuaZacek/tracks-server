import path from 'node:path';
import { z } from 'zod';

// Timetable and Darwin times are UK local time; work in the same zone whatever the host is set to.
process.env.TZ ||= 'Europe/London';

const trustProxy = z
  .string()
  .default('false')
  .transform((v): boolean | number | string => {
    if (v === 'true') return true;
    if (v === 'false' || v === '') return false;
    return /^\d+$/.test(v) ? Number(v) : v;
  });

/** Blank means "not configured". */
const optionalUrl = z.union([z.literal(''), z.url()]).default('');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  TRUST_PROXY: trustProxy,
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATA_DIR: z.string().default('./data'),
  SCHEDULE_REFRESH_TIME: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be HH:MM')
    .default('04:00'),
  RDM_AUTH_HEADER: z.string().default('x-apikey'),
  KB_STATIONS_URL: optionalUrl,
  KB_STATIONS_API_KEY: z.string().default(''),
  NWR_SCHEDULE_URL: optionalUrl,
  NWR_SCHEDULE_API_KEY: z.string().default(''),
  NWR_SCHEDULE_USERNAME: z.string().default(''),
  NWR_SCHEDULE_PASSWORD: z.string().default(''),
  DARWIN_KAFKA_BOOTSTRAP: z.string().default(''),
  DARWIN_KAFKA_TOPIC: z.string().default(''),
  DARWIN_KAFKA_GROUP_ID: z.string().default(''),
  DARWIN_KAFKA_USERNAME: z.string().default(''),
  DARWIN_KAFKA_PASSWORD: z.string().default(''),
  DARWIN_KAFKA_SASL_MECHANISM: z.enum(['plain', 'scram-sha-256', 'scram-sha-512']).default('plain'),
});

export type Config = ReturnType<typeof loadConfig>;

/** Reads and validates the environment once at startup; a bad value stops the process with a clear message. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${problems}`);
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY,
    databaseUrl: e.DATABASE_URL,
    dataDir: path.resolve(e.DATA_DIR),
    /** NWR Schedule extract: downloaded here when NWR_SCHEDULE_URL is set, otherwise replaced by hand. */
    scheduleFile: path.join(path.resolve(e.DATA_DIR), 'CIF_ALL_FULL_DAILY_toc-full.json.gz'),
    scheduleRefreshTime: e.SCHEDULE_REFRESH_TIME,
    rdm: {
      authHeader: e.RDM_AUTH_HEADER,
      kbStations: { url: e.KB_STATIONS_URL, key: e.KB_STATIONS_API_KEY },
      schedule: { url: e.NWR_SCHEDULE_URL, key: e.NWR_SCHEDULE_API_KEY, username: e.NWR_SCHEDULE_USERNAME, password: e.NWR_SCHEDULE_PASSWORD },
      darwin: {
        bootstrap: e.DARWIN_KAFKA_BOOTSTRAP,
        topic: e.DARWIN_KAFKA_TOPIC,
        groupId: e.DARWIN_KAFKA_GROUP_ID,
        username: e.DARWIN_KAFKA_USERNAME,
        password: e.DARWIN_KAFKA_PASSWORD,
        mechanism: e.DARWIN_KAFKA_SASL_MECHANISM,
      },
    },
  };
}

/** Every configured secret, so anything written to disk (samples, logs) can be checked for leaks. */
export function secretsOf(config: Config): string[] {
  const r = config.rdm;
  return [r.kbStations.key, r.schedule.key, r.schedule.password, r.darwin.username, r.darwin.password, r.darwin.groupId].filter((s) => s.length >= 8);
}
