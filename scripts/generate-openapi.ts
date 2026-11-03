import fs from 'node:fs';
import path from 'node:path';
import { buildOpenApiDocument } from '../src/http/openapi.ts';
import { routes } from '../src/routes.ts';

/** Writes openapi/openapi.json. With --check, fails if the committed file is out of date (for CI). */
const file = path.resolve(import.meta.dirname, '../openapi/openapi.json');
const json = JSON.stringify(buildOpenApiDocument(routes), null, 2) + '\n';

if (process.argv.includes('--check')) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (current !== json) {
    console.error('openapi/openapi.json is out of date: run npm run openapi');
    process.exit(1);
  }
  console.log('openapi/openapi.json is up to date');
} else {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, json);
  console.log(`Wrote ${path.relative(process.cwd(), file)}`);
}
