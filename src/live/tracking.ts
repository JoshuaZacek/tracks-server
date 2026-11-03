import type { Config } from '../config/env.ts';
import type { Db } from '../db/client.ts';
import { startDarwinConsumer } from '../darwin/consumer.ts';
import { pruneDarwin } from '../darwin/store.ts';
import type { Logger } from '../logger.ts';
import type { Notifier } from '../push/notifier.ts';
import { ukToday } from '../time.ts';
import { Lookups } from './lookups.ts';
import { journeysDueForTick, journeysForRuns, updateJourneys, type JourneyChange, type UpdaterDeps } from './updater.ts';

const TICK_MS = 30_000;
const PRUNE_MS = 60 * 60_000;

/**
 * Live tracking in the worker: the Darwin consumer updates journeys whose runs
 * change, and a clock tick handles changes that come from time passing
 * (entering the live window, not_found, arrival by deactivation). Changes go
 * to the notifier, which pushes in the background.
 */
export async function startTracking(db: Db, config: Config, log: Logger, notifier: Notifier | null = null) {
  const lookups = new Lookups(db);
  const enabled = Boolean(config.rdm.darwin.bootstrap);
  let consumer: Awaited<ReturnType<typeof startDarwinConsumer>> | null = null;
  const deps: UpdaterDeps = { db, lookups, now: () => new Date(), darwinEnabled: enabled, feedHealthy: () => consumer?.healthy() ?? false };

  const report = (changes: JourneyChange[]) => {
    for (const c of changes) {
      if (c.previous?.state !== c.status.state) log.info({ journey: c.journey.id, from: c.previous?.state ?? null, to: c.status.state }, 'Journey state changed');
    }
    notifier?.journeysChanged(changes.map((c) => c.journey.id));
  };

  if (enabled) {
    consumer = await startDarwinConsumer({
      db,
      config,
      log,
      lookups,
      onFlushed: async (touched) => report(await updateJourneys(deps, await journeysForRuns(db, touched))),
    });
  } else {
    log.warn('Darwin not configured (DARWIN_KAFKA_*): journeys show timetable data only');
  }

  let lastPrune = 0;
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      report(await updateJourneys(deps, await journeysDueForTick(db, new Date())));
      notifier?.tick();
      if (Date.now() - lastPrune > PRUNE_MS) {
        if (enabled) await pruneDarwin(db, ukToday());
        await notifier?.prune();
        lastPrune = Date.now();
      }
    } catch (err) {
      log.error({ err }, 'Tracking tick failed');
    } finally {
      ticking = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), TICK_MS);

  return async () => {
    clearInterval(timer);
    await consumer?.stop();
    await notifier?.close();
  };
}
