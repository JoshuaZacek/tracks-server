import { sql } from 'kysely';
import type { Db } from '../db/client.ts';
import { getMeta } from '../db/meta.ts';
import { titleCase } from '../ingest/schedule/parse.ts';
import { META_KEYS } from '../ingest/schedule/import.ts';

export interface StationInfo {
  name: string;
  lat: number | null;
  lon: number | null;
}

/**
 * TIPLOC → CRS/name and CRS → station, held in memory (~12k TIPLOCs, ~2.7k
 * stations). Reloaded when a new timetable is imported or every 10 minutes
 * (stations gain coordinates as Knowledgebase is fetched).
 */
export class Lookups {
  private tiplocs = new Map<string, { crs: string | null; name: string }>();
  private stations = new Map<string, StationInfo>();
  private loadedAt = 0;
  private importedAt: string | null = null;
  private loading: Promise<void> | null = null;
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Make sure the tables are loaded and not older than `maxAgeMs`. Cheap when fresh. */
  async ready(maxAgeMs = 10 * 60_000): Promise<this> {
    if (this.loading) await this.loading;
    if (Date.now() - this.loadedAt < maxAgeMs && this.loadedAt > 0) {
      // A cheap check for a newly imported timetable at most once a minute.
      if (Date.now() - this.loadedAt < 60_000) return this;
      if ((await getMeta(this.db, META_KEYS.importedAt)) === this.importedAt) return this;
    }
    this.loading = this.load().finally(() => (this.loading = null));
    await this.loading;
    return this;
  }

  private async load() {
    const importedAt = await getMeta(this.db, META_KEYS.importedAt);
    const [tiplocs, stations] = await Promise.all([
      sql<{ tiploc: string; crs: string | null; name: string }>`SELECT tiploc, crs, name FROM schedule.tiplocs`.execute(this.db),
      sql<{ crs: string; name: string; lat: number | null; lon: number | null }>`SELECT crs, name, lat, lon FROM stations`.execute(this.db),
    ]);
    this.stations = new Map(stations.rows.map((s) => [s.crs, { name: s.name, lat: s.lat, lon: s.lon }]));
    this.tiplocs = new Map(tiplocs.rows.map((t) => [t.tiploc, { crs: t.crs, name: t.name }]));
    this.importedAt = importedAt;
    this.loadedAt = Date.now();
  }

  crsOf = (tiploc: string): string | null => this.tiplocs.get(tiploc)?.crs ?? null;

  station = (crs: string): StationInfo | null => this.stations.get(crs) ?? null;

  /** Station name for a station TIPLOC, otherwise the TIPLOC's own description in title case. */
  nameOf = (tiploc: string): string => {
    const t = this.tiplocs.get(tiploc);
    if (t?.crs) {
      const s = this.stations.get(t.crs);
      if (s) return s.name;
    }
    return t ? titleCase(t.name) : tiploc;
  };
}
