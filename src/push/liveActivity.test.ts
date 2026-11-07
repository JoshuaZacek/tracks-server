import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { LiveStatus } from '../modules/journeys/schemas.ts';
import { isMaterialChange, liveActivityContent, sameContent, type LiveActivityContent } from './liveActivity.ts';

type LiveStatusOut = z.input<typeof LiveStatus>;

const J = { scheduledDeparture: '2026-11-07T16:35:00+00:00', scheduledArrival: '2026-11-07T18:07:00+00:00', bookedPlatform: '15', bookedArrivalPlatform: null };
const live = (over: Partial<LiveStatusOut> = {}): LiveStatusOut => ({
  state: 'live',
  checkedAt: '2026-11-07T16:20:00+00:00',
  nextPollSeconds: null,
  stale: false,
  message: null,
  service: null,
  progress: null,
  position: null,
  divides: null,
  loading: null,
  ...over,
});
const division = (note: string | null, theirs: boolean) => ({
  atCrs: 'HRH',
  atName: 'Horsham',
  at: '2026-11-07T17:27:00+00:00',
  portions: [
    { destCrs: 'PMH', destName: 'Portsmouth Harbour', yours: true, note },
    { destCrs: 'BOG', destName: 'Bognor Regis', yours: theirs, note: null },
  ],
  message: 'This train divides at Horsham; only some coaches go to Chichester.',
});

describe('liveActivityContent: divides', () => {
  it('is the short division text, with my coach note when there is one, and null without a division', () => {
    expect(liveActivityContent(J, live()).divides).toBeNull();
    expect(liveActivityContent(J, null).divides).toBeNull();
    expect(liveActivityContent(J, live({ divides: division(null, false) })).divides).toBe('Divides at Horsham');
    expect(liveActivityContent(J, live({ divides: division('Front 4 coaches', false) })).divides).toBe('Divides at Horsham · front 4 coaches');
    // Both parts go there: which coaches doesn't matter.
    expect(liveActivityContent(J, live({ divides: division('Front 4 coaches', true) })).divides).toBe('Divides at Horsham');
  });

  it('a loading-only change is no new content; a division appearing is, at high priority', () => {
    const before = liveActivityContent(J, live());
    const busier = liveActivityContent(J, live({ loading: { percentage: 90, level: 'very_busy', coaches: null, quietestCoaches: [] } }));
    expect(sameContent(before, busier)).toBe(true);
    const divides = liveActivityContent(J, live({ divides: division(null, false) }));
    expect(sameContent(before, divides)).toBe(false);
    expect(isMaterialChange(before, divides)).toBe(true);
  });

  it('content sent before the field existed matches content with no division', () => {
    const { divides: _divides, ...old } = liveActivityContent(J, live());
    expect(sameContent(old as LiveActivityContent, liveActivityContent(J, live()))).toBe(true);
  });
});
