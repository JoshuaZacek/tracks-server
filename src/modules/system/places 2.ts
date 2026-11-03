import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { DateTime } from '../../http/schemas.ts';

/**
 * OS Open Names extract for on-device nearest-town labels, built by
 * `npm run build:places` into assets/places.json. Loaded once, checked against
 * its schema, and served pre-compressed with an ETag so the app downloads it
 * once and then only revalidates.
 */
export const PLACES_FILE = new URL('../../../assets/places.json', import.meta.url);

export const PlacesDataset = z
  .object({
    source: z.string(),
    attribution: z.string(),
    generatedAt: DateTime,
    types: z.array(z.string()),
    places: z.array(z.array(z.union([z.string(), z.number()]))),
  })
  .meta({ id: 'PlacesDataset' });

interface Prepared {
  json: Buffer;
  gzip: Buffer;
  etag: string;
}
let prepared: Prepared | null = null;

function prepare(): Prepared {
  if (prepared) return prepared;
  const raw = JSON.parse(fs.readFileSync(PLACES_FILE, 'utf8')) as { generatedAt?: string };
  // Normalise the build time to the API's date-time format (UK offset, no fractions).
  if (raw.generatedAt) raw.generatedAt = toIsoNoFraction(raw.generatedAt);
  const data = PlacesDataset.parse(raw);
  const json = Buffer.from(JSON.stringify(data));
  prepared = { json, gzip: gzipSync(json, { level: 9 }), etag: `"${createHash('sha256').update(json).digest('base64url').slice(0, 27)}"` };
  return prepared;
}

function toIsoNoFraction(value: string) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

export function sendPlaces(req: Request, res: Response) {
  const p = prepare();
  res.set({ ETag: p.etag, 'Cache-Control': 'public, max-age=86400', Vary: 'Accept-Encoding' });
  if (req.fresh) {
    res.status(304).end();
    return;
  }
  res.type('application/json');
  if (req.acceptsEncodings('gzip') === 'gzip') res.set('Content-Encoding', 'gzip').send(p.gzip);
  else res.send(p.json);
}
