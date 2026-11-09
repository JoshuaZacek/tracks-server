import type { z } from 'zod';
import type { SharedJourney } from './schemas.ts';

/**
 * The page a share link opens (GET /s/{token}): the shared journey drawn on the
 * server, so it shows without JavaScript and in link previews, then kept up to
 * date by /s/share.js polling GET /v1/shared/{token} at the pace it asks for.
 * No inline script, so helmet's default Content-Security-Policy (script-src
 * 'self') applies unchanged. Everything shown is escaped.
 */

type View = z.input<typeof SharedJourney>;

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

const hhmm = (iso: string | null | undefined) => (iso ? iso.slice(11, 16) : '');
const lateText = (d: number | null) => (d !== null && d > 0 ? `${d} min late` : 'On time');

/** The headline: how the train is doing. Kept in step with statusText in SHARE_SCRIPT. */
export function statusText(v: Pick<View, 'state' | 'delayMinutes' | 'message'>) {
  switch (v.state) {
    case 'cancelled':
      return 'Cancelled';
    case 'arrived':
      return `Arrived · ${lateText(v.delayMinutes).toLowerCase()}`;
    case 'departed':
      return `On its way · ${lateText(v.delayMinutes).toLowerCase()}`;
    case 'not_found':
      return 'No live information';
    default:
      return v.delayMinutes === null ? 'No live times yet' : lateText(v.delayMinutes);
  }
}

const STYLE = `
:root { color-scheme: light dark; --bg: #f4f5f7; --card: #fff; --ink: #14171a; --muted: #5f6b76; --line: #dde1e6; --accent: #0f8b8d; --late: #b4570b; --bad: #c62828; }
@media (prefers-color-scheme: dark) { :root { --bg: #0f1214; --card: #1a1f23; --ink: #eef1f3; --muted: #9aa6b0; --line: #2b3238; --accent: #3cc4c6; --late: #f0a04b; --bad: #ff6b6b; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width: 34rem; margin: 0 auto; padding: 24px 16px 40px; }
.card { background: var(--card); border-radius: 18px; padding: 18px; border: 1px solid var(--line); }
.op { margin: 0 0 4px; color: var(--muted); font-size: 14px; }
h1 { margin: 0 0 10px; font-size: 22px; line-height: 1.25; }
.status { margin: 0 0 16px; font-weight: 600; color: var(--accent); }
.status[data-tone="late"] { color: var(--late); }
.status[data-tone="bad"] { color: var(--bad); }
.times { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.times span { display: block; color: var(--muted); font-size: 13px; }
.times b { font-size: 20px; font-variant-numeric: tabular-nums; }
.times s { color: var(--muted); font-size: 14px; margin-left: 4px; }
ol { list-style: none; margin: 18px 0 0; padding: 0; border-top: 1px solid var(--line); }
li { display: flex; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--line); }
li.passed { color: var(--muted); }
li.cancelled .name { text-decoration: line-through; }
li .t { font-variant-numeric: tabular-nums; white-space: nowrap; }
.foot { color: var(--muted); font-size: 13px; margin: 14px 4px 0; }
.note { margin: 0 0 12px; color: var(--muted); }
`;

function head(title: string) {
  return (
    '<!doctype html><html lang="en-GB"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow">' +
    `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>`
  );
}

const tone = (v: View) => (v.state === 'cancelled' || v.isCancelled ? 'bad' : (v.delayMinutes ?? 0) > 0 ? 'late' : 'ok');

function timeCell(label: string, scheduled: string, best: string | null, id: string) {
  const changed = best && hhmm(best) !== hhmm(scheduled);
  return `<div><span>${label}</span><b id="${id}">${hhmm(best ?? scheduled)}</b>${changed ? `<s id="${id}-was">${hhmm(scheduled)}</s>` : `<s id="${id}-was" hidden></s>`}</div>`;
}

function stopsHtml(v: View) {
  return v.stops
    .map((s) => {
      const best = s.actual ?? s.expected;
      const cls = [s.passed ? 'passed' : '', s.isCancelled ? 'cancelled' : ''].filter(Boolean).join(' ');
      const time = s.isCancelled ? 'Cancelled' : best && hhmm(best) !== hhmm(s.scheduled) ? `${hhmm(best)} (${hhmm(s.scheduled)})` : hhmm(s.scheduled);
      return `<li${cls ? ` class="${cls}"` : ''}><span class="name">${escapeHtml(s.name)}</span><span class="t">${escapeHtml(time)}</span></li>`;
    })
    .join('');
}

export function renderSharePage(v: View, token: string) {
  const route = `${v.from.name} to ${v.to.name}`;
  return (
    head(`${hhmm(v.scheduledDeparture)} ${route} · tracks`) +
    `<body><main id="shared" data-token="${escapeHtml(token)}" data-poll="${v.nextPollSeconds ?? ''}"><div class="card">` +
    `<p class="op">${escapeHtml(v.operator.name)} · ${escapeHtml(v.headcode)} · ${hhmm(v.scheduledDeparture)}</p>` +
    `<h1>${escapeHtml(v.from.name)} → ${escapeHtml(v.to.name)}</h1>` +
    `<p class="status" id="status" data-tone="${tone(v)}">${escapeHtml(statusText(v))}</p>` +
    (v.message ? `<p class="note" id="message">${escapeHtml(v.message)}</p>` : '<p class="note" id="message" hidden></p>') +
    '<div class="times">' +
    timeCell('Departs', v.scheduledDeparture, v.actualDeparture ?? v.expectedDeparture, 'dep') +
    timeCell('Arrives', v.scheduledArrival, v.actualArrival ?? v.expectedArrival, 'arr') +
    `<div><span>Platform</span><b id="plat">${v.platform ? escapeHtml(v.platform.number) : '–'}</b></div>` +
    '</div>' +
    `<ol id="stops">${stopsHtml(v)}</ol></div>` +
    `<p class="foot" id="updated">Updated ${hhmm(v.checkedAt)}${v.stale ? ' (live updates paused)' : ''} · link works until ${hhmm(v.expiresAt)}</p>` +
    '</main><script src="/s/share.js" defer></script></body></html>'
  );
}

export function renderMissingPage() {
  return (
    head('Journey not shared · tracks') +
    '<body><main><div class="card"><h1>This journey is no longer shared</h1>' +
    '<p class="note">The link has expired, or whoever shared it stopped sharing.</p></div></main></body></html>'
  );
}

/**
 * /s/share.js: polls the JSON and redraws the page, at the pace the server
 * asks (nextPollSeconds, at least 15 s), until the journey is final or the
 * link stops working. Builds DOM nodes with textContent, never HTML.
 */
export const SHARE_SCRIPT = `(() => {
  const main = document.getElementById('shared');
  if (!main) return;
  const token = main.dataset.token;
  const $ = (id) => document.getElementById(id);
  const hhmm = (iso) => (iso ? iso.slice(11, 16) : '');
  const late = (d) => (d !== null && d > 0 ? d + ' min late' : 'On time');
  const statusText = (v) => {
    switch (v.state) {
      case 'cancelled': return 'Cancelled';
      case 'arrived': return 'Arrived · ' + late(v.delayMinutes).toLowerCase();
      case 'departed': return 'On its way · ' + late(v.delayMinutes).toLowerCase();
      case 'not_found': return 'No live information';
      default: return v.delayMinutes === null ? 'No live times yet' : late(v.delayMinutes);
    }
  };
  const setTime = (id, scheduled, best) => {
    $(id).textContent = hhmm(best || scheduled);
    const was = $(id + '-was');
    const changed = best && hhmm(best) !== hhmm(scheduled);
    was.hidden = !changed;
    was.textContent = changed ? hhmm(scheduled) : '';
  };
  const render = (v) => {
    const status = $('status');
    status.textContent = statusText(v);
    status.dataset.tone = v.state === 'cancelled' || v.isCancelled ? 'bad' : (v.delayMinutes || 0) > 0 ? 'late' : 'ok';
    const message = $('message');
    message.hidden = !v.message;
    message.textContent = v.message || '';
    setTime('dep', v.scheduledDeparture, v.actualDeparture || v.expectedDeparture);
    setTime('arr', v.scheduledArrival, v.actualArrival || v.expectedArrival);
    $('plat').textContent = v.platform ? v.platform.number : '–';
    const list = $('stops');
    list.replaceChildren(...v.stops.map((s) => {
      const li = document.createElement('li');
      if (s.passed) li.classList.add('passed');
      if (s.isCancelled) li.classList.add('cancelled');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = s.name;
      const t = document.createElement('span');
      t.className = 't';
      const best = s.actual || s.expected;
      t.textContent = s.isCancelled ? 'Cancelled' : best && hhmm(best) !== hhmm(s.scheduled) ? hhmm(best) + ' (' + hhmm(s.scheduled) + ')' : hhmm(s.scheduled);
      li.append(name, t);
      return li;
    }));
    $('updated').textContent = 'Updated ' + hhmm(v.checkedAt) +
      (v.stale ? ' (live updates paused)' : '') + ' · link works until ' + hhmm(v.expiresAt);
  };
  const poll = async (seconds) => {
    await new Promise((r) => setTimeout(r, Math.max(15, seconds) * 1000));
    try {
      const res = await fetch('/v1/shared/' + encodeURIComponent(token), { cache: 'no-store' });
      if (res.status === 404) { location.reload(); return; }
      if (!res.ok) return poll(60);
      const v = await res.json();
      render(v);
      if (v.nextPollSeconds !== null) poll(v.nextPollSeconds);
    } catch {
      poll(60);
    }
  };
  // The first wait is the one the page was drawn with; none when the journey is final.
  if (main.dataset.poll) poll(Number(main.dataset.poll));
})();
`;
