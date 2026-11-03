/**
 * British National Grid (OSGB36 easting/northing) to WGS84 latitude/longitude:
 * inverse Transverse Mercator on the Airy 1830 ellipsoid, then the standard
 * 7-parameter Helmert transform. Accurate to a few metres, plenty for naming
 * the nearest town.
 */

const AIRY = { a: 6377563.396, b: 6356256.909 };
const WGS84 = { a: 6378137, b: 6356752.3142 };
const F0 = 0.9996012717;
const LAT0 = (49 * Math.PI) / 180;
const LON0 = (-2 * Math.PI) / 180;
const N0 = -100000;
const E0 = 400000;
// OSGB36 -> WGS84 (metres, ppm, arcseconds).
const HELMERT = { tx: 446.448, ty: -125.157, tz: 542.06, s: -20.4894, rx: 0.1502, ry: 0.247, rz: 0.8421 };

function gridToOsgb36(E: number, N: number) {
  const { a, b } = AIRY;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b);
  const n2 = n * n;
  const n3 = n2 * n;

  const meridionalArc = (lat: number) => {
    const d = lat - LAT0;
    const s = lat + LAT0;
    return (
      b *
      F0 *
      ((1 + n + (5 / 4) * n2 + (5 / 4) * n3) * d -
        (3 * n + 3 * n2 + (21 / 8) * n3) * Math.sin(d) * Math.cos(s) +
        ((15 / 8) * n2 + (15 / 8) * n3) * Math.sin(2 * d) * Math.cos(2 * s) -
        (35 / 24) * n3 * Math.sin(3 * d) * Math.cos(3 * s))
    );
  };

  let lat = LAT0;
  let M = 0;
  do {
    lat = (N - N0 - M) / (a * F0) + lat;
    M = meridionalArc(lat);
  } while (Math.abs(N - N0 - M) >= 0.00001);

  const sin = Math.sin(lat);
  const cos = Math.cos(lat);
  const tan = Math.tan(lat);
  const nu = (a * F0) / Math.sqrt(1 - e2 * sin * sin);
  const rho = (a * F0 * (1 - e2)) / Math.pow(1 - e2 * sin * sin, 1.5);
  const eta2 = nu / rho - 1;

  const VII = tan / (2 * rho * nu);
  const VIII = (tan / (24 * rho * nu ** 3)) * (5 + 3 * tan ** 2 + eta2 - 9 * tan ** 2 * eta2);
  const IX = (tan / (720 * rho * nu ** 5)) * (61 + 90 * tan ** 2 + 45 * tan ** 4);
  const X = 1 / (cos * nu);
  const XI = (1 / (cos * 6 * nu ** 3)) * (nu / rho + 2 * tan ** 2);
  const XII = (1 / (cos * 120 * nu ** 5)) * (5 + 28 * tan ** 2 + 24 * tan ** 4);
  const XIIA = (1 / (cos * 5040 * nu ** 7)) * (61 + 662 * tan ** 2 + 1320 * tan ** 4 + 720 * tan ** 6);

  const dE = E - E0;
  return {
    lat: lat - VII * dE ** 2 + VIII * dE ** 4 - IX * dE ** 6,
    lon: LON0 + X * dE - XI * dE ** 3 + XII * dE ** 5 - XIIA * dE ** 7,
  };
}

function toCartesian(lat: number, lon: number, { a, b }: { a: number; b: number }) {
  const e2 = 1 - (b * b) / (a * a);
  const nu = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return { x: nu * Math.cos(lat) * Math.cos(lon), y: nu * Math.cos(lat) * Math.sin(lon), z: nu * (1 - e2) * Math.sin(lat) };
}

function fromCartesian({ x, y, z }: { x: number; y: number; z: number }, { a, b }: { a: number; b: number }) {
  const e2 = 1 - (b * b) / (a * a);
  const p = Math.sqrt(x * x + y * y);
  let lat = Math.atan2(z, p * (1 - e2));
  for (let i = 0; i < 10; i++) {
    const nu = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    lat = Math.atan2(z + e2 * nu * Math.sin(lat), p);
  }
  return { lat, lon: Math.atan2(y, x) };
}

export function bngToWgs84(easting: number, northing: number): { lat: number; lon: number } {
  const osgb = gridToOsgb36(easting, northing);
  const c = toCartesian(osgb.lat, osgb.lon, AIRY);
  const sec = Math.PI / (180 * 3600);
  const { tx, ty, tz } = HELMERT;
  const s = HELMERT.s * 1e-6;
  const rx = HELMERT.rx * sec;
  const ry = HELMERT.ry * sec;
  const rz = HELMERT.rz * sec;
  const w = fromCartesian(
    {
      x: tx + (1 + s) * c.x - rz * c.y + ry * c.z,
      y: ty + rz * c.x + (1 + s) * c.y - rx * c.z,
      z: tz - ry * c.x + rx * c.y + (1 + s) * c.z,
    },
    WGS84,
  );
  return { lat: (w.lat * 180) / Math.PI, lon: (w.lon * 180) / Math.PI };
}
