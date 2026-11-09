import type { z } from 'zod';
import type { LiveStatus } from '../modules/journeys/schemas.ts';

/**
 * Delay Repay: what a late or cancelled journey may be able to claim from the
 * operator. The rules are data (one row per operator); `eligibility` and
 * `claimOf` are pure, so they are unit-tested on their own.
 *
 * Source: gov.uk "Rail passenger compensation paid by train operating companies"
 * (updated 26 February 2026). Every Delay Repay operator pays from 30 minutes;
 * 13 also pay from 15 (Delay Repay 15). The bands are the same everywhere:
 * 25 % of the single fare for 15–29 min, 50 % for 30–59, 100 % from 60, and
 * 100 % of a return from 2 hours. Under 2 hours a return ticket gets the
 * percentage of its single half, so half the percentage of what it cost.
 *
 * Operators with their own schemes (Heathrow Express, Merseyrail, Elizabeth
 * line) or outside National Rail are left out: no claim is offered for them.
 * Operators not on the gov.uk page (ScotRail, open access) are left out until
 * their schemes are checked.
 *
 * Before release, check each row against the operator's published scheme and
 * set `checkedOn`. A claim URL with checkedOn null has not been confirmed (the
 * operator's site refused automated reads, or the page could not be found).
 */

export type DelayRepayScheme = 'DR15' | 'DR30';
export type TicketType = 'single' | 'return';

export interface DelayRepayBand {
  minMinutes: number;
  /** Null for the top band. */
  maxMinutes: number | null;
  /** Of a single fare. */
  singlePercent: number;
  /** Of a return fare (delayed one way). */
  returnPercent: number;
}

export interface DelayRepayRule {
  scheme: DelayRepayScheme;
  /** Where to claim: the operator's claim form, else its Delay Repay page. */
  claimUrl: string;
  /** When the scheme and URL were last checked against the operator's own page ("YYYY-MM-DD"); null = not yet. */
  checkedOn: string | null;
}

export const DR15_BANDS: readonly DelayRepayBand[] = [
  { minMinutes: 15, maxMinutes: 29, singlePercent: 25, returnPercent: 12.5 },
  { minMinutes: 30, maxMinutes: 59, singlePercent: 50, returnPercent: 25 },
  { minMinutes: 60, maxMinutes: 119, singlePercent: 100, returnPercent: 50 },
  { minMinutes: 120, maxMinutes: null, singlePercent: 100, returnPercent: 100 },
];
export const DR30_BANDS: readonly DelayRepayBand[] = DR15_BANDS.slice(1);

const BANDS: Record<DelayRepayScheme, readonly DelayRepayBand[]> = { DR15: DR15_BANDS, DR30: DR30_BANDS };

const dr15 = (claimUrl: string, checkedOn: string | null = null): DelayRepayRule => ({ scheme: 'DR15', claimUrl, checkedOn });
const dr30 = (claimUrl: string, checkedOn: string | null = null): DelayRepayRule => ({ scheme: 'DR30', claimUrl, checkedOn });
const CHECKED = '2026-11-09';

/** By ATOC code (schedule `atoc_code`). */
export const DELAY_REPAY_RULES: Readonly<Record<string, DelayRepayRule>> = {
  // Govia Thameslink Railway
  TL: dr15('https://www.thameslinkrailway.com/help-and-support/delay-repay'),
  GN: dr15('https://www.greatnorthernrail.com/help-and-support/delay-repay'),
  SN: dr15('https://www.southernrailway.com/help-and-support/delay-repay'),
  GX: dr15('https://www.gatwickexpress.com/help-and-support/delay-repay'),
  EM: dr15('https://www.eastmidlandsrailway.co.uk/help-manage/delay-repay'),
  LM: dr15('https://www.westmidlandsrailway.co.uk/help-support/delay-repay'),
  SE: dr15('https://delayrepay.southeasternrailway.co.uk/', CHECKED),
  LE: dr15('https://www.greateranglia.co.uk/about-us/our-performance/delay-repay'),
  VT: dr15('https://delayrepay.avantiwestcoast.co.uk/en/', CHECKED),
  CC: dr15('https://c2c.delayrepaycompensation.com/index.cfm', CHECKED),
  AW: dr15('https://delayrepay.trc.cymru/en/make-claim', CHECKED),
  CH: dr15('https://www.chilternrailways.co.uk/'),
  GW: dr15('https://delayrepay.gwr.com/', CHECKED),
  NT: dr15('https://www.northernrailway.co.uk/delay-repay'),
  SW: dr15('https://delayrepay.southwesternrailway.com/', CHECKED),
  // Island Line is run by South Western Railway, under its scheme.
  IL: dr15('https://delayrepay.southwesternrailway.com/', CHECKED),
  TP: dr15('https://www.tpexpress.co.uk/'),
  GR: dr30('https://www.lner.co.uk/'),
  XC: dr30('https://www.crosscountrytrains.co.uk/customer-service/delay-repay'),
};

export interface Eligibility {
  toc: string;
  scheme: DelayRepayScheme;
  /** The smallest delay that qualifies. */
  minimumMinutes: number;
  /** Minutes late at my destination; null for a cancellation. */
  delayMinutes: number | null;
  cancelled: boolean;
  /** The band the delay falls in; null for a cancellation (it depends on the train taken instead, or a refund). */
  band: DelayRepayBand | null;
  claimUrl: string;
}

/**
 * Whether a finished journey qualifies, and for which band. `finalDelay` is the
 * arrival delay at my destination in minutes; `cancelled` means my train was
 * cancelled or no longer called at my destination. Null when nothing can be
 * claimed (not late enough, delay unknown, or an operator without rules).
 */
export function eligibility(finalDelay: number | null, cancelled: boolean, toc: string): Eligibility | null {
  const rule = DELAY_REPAY_RULES[toc];
  if (!rule) return null;
  const bands = BANDS[rule.scheme];
  const base = { toc, scheme: rule.scheme, minimumMinutes: bands[0]!.minMinutes, claimUrl: rule.claimUrl };
  if (cancelled) return { ...base, delayMinutes: null, cancelled: true, band: null };
  if (finalDelay === null) return null;
  const band = bands.findLast((b) => finalDelay >= b.minMinutes);
  return band ? { ...base, delayMinutes: finalDelay, cancelled: false, band } : null;
}

/** What the claim may pay, in pence (rounded down); null without a band, a price or a ticket type. */
export function estimatePence(band: DelayRepayBand | null, pricePence: number | null, ticket: TicketType | null): number | null {
  if (!band || pricePence === null || ticket === null) return null;
  const percent = ticket === 'single' ? band.singlePercent : band.returnPercent;
  return Math.floor((pricePence * percent) / 100);
}

// ---- from a journey's live status ------------------------------------------------------

type LiveStatusOut = z.input<typeof LiveStatus>;

export interface JourneyOutcome {
  /** Minutes late at my destination; null for a cancellation. */
  delayMinutes: number | null;
  cancelled: boolean;
  /** At my destination; null for a cancellation. */
  actualArrival: string | null;
}

const destinationCancelled = (s: LiveStatusOut) => {
  const dest = s.progress?.stops.at(-1);
  return s.state === 'cancelled' || ((s.service?.isCancelled ?? false) && (dest?.isCancelled ?? false));
};

/**
 * How a journey ended, once it has: arrived (with the delay at my destination),
 * or cancelled at my station or my destination once its scheduled arrival has
 * gone by (until then the user may still be travelling another way). Null while
 * it isn't over, or without live data.
 */
export function journeyOutcome(s: LiveStatusOut | null, scheduledArrival: string, now: Date): JourneyOutcome | null {
  if (!s) return null;
  if (s.state === 'arrived') {
    const dest = s.progress?.stops.at(-1);
    const delay = dest?.delayMinutes ?? null;
    return delay === null ? null : { delayMinutes: delay, cancelled: false, actualArrival: dest?.actual ?? null };
  }
  if (destinationCancelled(s) && now.getTime() >= Date.parse(scheduledArrival)) return { delayMinutes: null, cancelled: true, actualArrival: null };
  return null;
}

export type Claim = Eligibility & { actualArrival: string | null };

/** The Delay Repay claim a journey's live status supports now, if any. */
export function claimOf(s: LiveStatusOut | null, j: { toc: string; scheduledArrival: string }, now: Date): Claim | null {
  const outcome = journeyOutcome(s, j.scheduledArrival, now);
  if (!outcome) return null;
  const e = eligibility(outcome.delayMinutes, outcome.cancelled, j.toc);
  return e ? { ...e, actualArrival: outcome.actualArrival } : null;
}
