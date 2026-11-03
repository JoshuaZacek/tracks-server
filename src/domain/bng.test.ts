import { assert, test } from 'vitest';
import { bngToWgs84 } from './bng.ts';

test('OS worked example (Caister water tower) converts to the published WGS84 position', () => {
  // TG 51409.903 13177.270 -> 52°39′28.72″N 001°42′57.79″E
  const { lat, lon } = bngToWgs84(651409.903, 313177.27);
  assert.ok(Math.abs(lat - (52 + 39 / 60 + 28.72 / 3600)) < 0.00002, `lat ${lat}`);
  assert.ok(Math.abs(lon - (1 + 42 / 60 + 57.79 / 3600)) < 0.00002, `lon ${lon}`);
});
