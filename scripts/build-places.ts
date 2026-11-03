/**
 * Builds the bundled place-names file used for "near <town>" in live mode, from
 * OS Open Names (Open Government Licence; free, no key).
 *
 *   npm run build:places
 *
 * Downloads DATA_DIR/opname_csv_gb.zip if it isn't there (~100 MB, needs
 * `unzip`), keeps cities, towns, villages and suburban areas, converts their
 * grid references to latitude/longitude, and writes assets/places.json (served by
 * GET /v1/reference/places).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/env.ts';
import { bngToWgs84 } from '../src/domain/bng.ts';

const config = loadConfig();
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const ZIP = path.join(config.dataDir, 'opname_csv_gb.zip');
const DOWNLOAD = 'https://api.os.uk/downloads/v1/products/OpenNames/downloads?area=GB&format=CSV&redirect';
const OUT = path.join(repoRoot, 'assets/places.json');
const TYPES = ['City', 'Town', 'Village', 'Suburban Area'];

fs.mkdirSync(config.dataDir, { recursive: true });
if (!fs.existsSync(ZIP)) {
  console.log(`Downloading OS Open Names to ${ZIP}`);
  const res = await fetch(DOWNLOAD);
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as WebReadableStream), fs.createWriteStream(`${ZIP}.part`));
  fs.renameSync(`${ZIP}.part`, ZIP);
}

function unzipLines(pattern: string) {
  const child = spawn('unzip', ['-p', ZIP, pattern]);
  child.on('error', (err) => {
    throw new Error(`Could not run unzip: ${err.message}`);
  });
  return readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
}

/** Minimal CSV: commas, double-quoted fields, "" escapes. */
function parseCsv(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(field);
      field = '';
    } else field += ch;
  }
  out.push(field);
  return out;
}

let header: string[] = [];
for await (const line of unzipLines('Doc/OS_Open_Names_Header.csv')) {
  if (line.trim()) header = parseCsv(line.replace(/^\uFEFF/, ''));
}
const col = (name: string) => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`Column ${name} missing from header`);
  return i;
};
const C = {
  name1: col('NAME1'),
  lang1: col('NAME1_LANG'),
  name2: col('NAME2'),
  lang2: col('NAME2_LANG'),
  type: col('TYPE'),
  localType: col('LOCAL_TYPE'),
  x: col('GEOMETRY_X'),
  y: col('GEOMETRY_Y'),
  xmin: col('MBR_XMIN'),
  ymin: col('MBR_YMIN'),
  xmax: col('MBR_XMAX'),
  ymax: col('MBR_YMAX'),
};
const E5 = (v: number) => Math.round(v * 1e5);

/** [name, lat, lon, type index] (+ [south, west, north, east] extent for cities and towns), degrees * 1e5 */
const places: (string | number)[][] = [];
for await (const line of unzipLines('Data/*.csv')) {
  if (!line.includes(',populatedPlace,')) continue;
  const f = parseCsv(line);
  const type = TYPES.indexOf(f[C.localType] ?? '');
  if (f[C.type] !== 'populatedPlace' || type < 0) continue;
  // Bilingual names: show the English one in this English-language app.
  const name = (f[C.lang2] === 'eng' && f[C.name2] ? f[C.name2] : f[C.name1]) ?? '';
  const { lat, lon } = bngToWgs84(Number(f[C.x]), Number(f[C.y]));
  const row: (string | number)[] = [name, E5(lat), E5(lon), type];
  // The extent lets "In London" work anywhere in London, not just near its centre point.
  if (type <= 1 && f[C.xmin]) {
    const sw = bngToWgs84(Number(f[C.xmin]), Number(f[C.ymin]));
    const ne = bngToWgs84(Number(f[C.xmax]), Number(f[C.ymax]));
    row.push(E5(sw.lat), E5(sw.lon), E5(ne.lat), E5(ne.lon));
  }
  places.push(row);
}
places.sort((a, b) => (a[1] as number) - (b[1] as number));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(
  OUT,
  JSON.stringify({
    source: 'OS Open Names',
    attribution: `Contains OS data © Crown copyright and database right ${new Date().getFullYear()}`,
    generatedAt: new Date().toISOString(),
    types: TYPES,
    places,
  }),
);
const counts = TYPES.map((t, i) => `${places.filter((p) => p[3] === i).length} ${t}`).join(', ');
console.log(`Wrote ${places.length} places (${counts}) to ${path.relative(repoRoot, OUT)}, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
