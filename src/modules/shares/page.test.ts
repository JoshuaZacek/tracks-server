import { describe, expect, it } from 'vitest';
import { renderMissingPage, renderSharePage } from './page.ts';

const view = {
  headcode: '1S25',
  operator: { code: 'GR', name: 'LNER' },
  from: { crs: 'KGX', name: 'London <Kings> Cross', lat: null, lon: null },
  to: { crs: 'YRK', name: `York "&" <script>alert(1)</script>`, lat: null, lon: null },
  scheduledDeparture: '2026-11-03T17:00:00+00:00',
  scheduledArrival: '2026-11-03T19:00:00+00:00',
  state: 'live' as const,
  message: null,
  stale: false,
  checkedAt: '2026-11-03T16:40:00+00:00',
  nextPollSeconds: 30,
  expectedDeparture: '2026-11-03T17:08:00+00:00',
  actualDeparture: null,
  expectedArrival: null,
  actualArrival: null,
  delayMinutes: 8,
  platform: { number: '7', source: 'live' as const, confirmed: true, hidden: false },
  isCancelled: false,
  stops: [],
  position: null,
  expiresAt: '2026-11-04T01:00:00+00:00',
};

describe('the shared journey page', () => {
  it('escapes everything it shows', () => {
    const html = renderSharePage(view, 'AAAAAAAAAAAAAAAAAAAAAA');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('York &quot;&amp;&quot; &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('London &lt;Kings&gt; Cross');
  });

  it('shows the times, delay and platform as first drawn, and carries the token for the script', () => {
    const html = renderSharePage(view, 'AAAAAAAAAAAAAAAAAAAAAA');
    expect(html).toContain('17:00');
    expect(html).toContain('8 min late');
    expect(html).toContain('<b id="plat">7</b>');
    expect(html).toContain('data-poll="30"');
    expect(html).toContain('data-token="AAAAAAAAAAAAAAAAAAAAAA"');
    expect(html).toMatch(/<meta name="robots" content="noindex, nofollow">/);
  });

  it("doesn't call a train on time before there are live times", () => {
    expect(renderSharePage({ ...view, delayMinutes: null, state: 'scheduled' }, 'AAAAAAAAAAAAAAAAAAAAAA')).toContain('No live times yet');
  });

  it('has a plain page for a link that has expired or was stopped', () => {
    expect(renderMissingPage()).toContain('no longer shared');
  });
});
