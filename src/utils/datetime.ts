// Why: every booking/job/mission/offer timestamp is stored as UTC (timestamptz)
// on the backend, and the ops console renders it in UTC. The mobile app used to
// render the same instants in the viewer's *device* timezone (toLocale*), so a
// pickup stored as 14:00Z showed "18:00" on a Gulf phone and "14:00Z" in ops —
// the two never matched and read as "out of sync with the backend".
//
// These helpers format operational timestamps in UTC everywhere, with an
// explicit 'Z' label, so mobile and ops show the exact same wall clock as the
// stored value regardless of the device's timezone. Implemented with getUTC*
// (not Intl) so the output is deterministic and engine-independent.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad = (n: number): string => n.toString().padStart(2, '0');

function toDate(iso: string | number | Date | null | undefined): Date | null {
  if (iso === null || iso === undefined || iso === '') {return null;}
  const d = iso instanceof Date ? iso : new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "14:00Z" — 24h UTC time with an explicit zone label. */
export function fmtTimeUtc(iso: string | number | Date | null | undefined): string {
  const d = toDate(iso);
  if (!d) {return '—';}
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
}

/** "Tue 23 Jun" — short weekday + day + month, in UTC. */
export function fmtDateUtc(iso: string | number | Date | null | undefined): string {
  const d = toDate(iso);
  if (!d) {return '—';}
  return `${DAYS[d.getUTCDay()]} ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]}`;
}

/** "23 Jun" — day + month only, in UTC (compact card use). */
export function fmtDayMonthUtc(iso: string | number | Date | null | undefined): string {
  const d = toDate(iso);
  if (!d) {return '—';}
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]}`;
}

/** "Tue 23 Jun · 14:00Z" — full date + time, in UTC. */
export function fmtDateTimeUtc(iso: string | number | Date | null | undefined): string {
  const d = toDate(iso);
  if (!d) {return '—';}
  return `${fmtDateUtc(d)} · ${fmtTimeUtc(d)}`;
}
