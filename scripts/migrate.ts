import { loadConfig } from '../src/config/env.ts';
import { createDb } from '../src/db/client.ts';
import { migrateToLatest } from '../src/db/migrate.ts';

const config = loadConfig();
const db = createDb(config.databaseUrl, { max: 1, applicationName: 'tracks-migrate' });
try {
  const results = await migrateToLatest(db);
  if (!results.length) console.log('Database is up to date');
  for (const r of results) console.log(`${r.status === 'Success' ? 'applied' : r.status}: ${r.name}`);
} catch (err) {
  console.error('Migration failed:', err);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
