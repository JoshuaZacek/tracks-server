import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './types.ts';

export type Db = Kysely<Database>;

// Return DATE columns as 'YYYY-MM-DD' strings: run dates are calendar dates, not instants.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export function createDb(databaseUrl: string, opts: { max?: number; applicationName?: string } = {}): Db {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? 'tracks-server',
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
