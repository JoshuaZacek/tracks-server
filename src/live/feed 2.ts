import type { Db } from '../db/client.ts';
import { FEED_HEALTHY_MS } from '../darwin/consumer.ts';
import { readFeedState, type FeedState } from '../darwin/store.ts';

let cache: { at: number; state: FeedState | null } | null = null;

/** The worker's record of the Darwin feed, cached for 10 s in the API. */
export async function feedState(db: Db): Promise<FeedState | null> {
  if (cache && Date.now() - cache.at < 10_000) return cache.state;
  const state = await readFeedState(db);
  cache = { at: Date.now(), state };
  return state;
}

export const feedHealthy = (state: FeedState | null, now = Date.now()) => !!state && now - Date.parse(state.lastMessageAt) < FEED_HEALTHY_MS;

/** For tests. */
export const resetFeedCache = () => {
  cache = null;
};
