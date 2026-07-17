// Backend booking statuses are UPPERCASE (`PENDING_OPS`, `OPS_APPROVED`, …)
// while the legacy `BookingStatus` type uses lowercase. This helper maps
// either casing to a display config and identifies bookings that should
// resume the ops-review / payment flow on app re-entry.

export interface StatusDisplay {
  label: string;
  color: string;
  isActive: boolean;
  needsAttention: boolean;
}

const FALLBACK: StatusDisplay = {
  label: 'UNKNOWN', color: '#475569', isActive: false, needsAttention: false,
};

const CONFIG: Record<string, StatusDisplay> = {
  DRAFT:           {label: 'DRAFT',       color: '#475569', isActive: false, needsAttention: false},
  // Auto-dispatch (Uber-style): searching for the nearest agency — active, no attention.
  DISPATCHING:     {label: 'SEARCHING',   color: '#5B8DEF', isActive: true,  needsAttention: false},
  // Ops-gated auto dispatch: an AUTO booking now parks here after submit too
  // ("Submitted — awaiting ops approval", same OpsRoomReview presentation as legacy);
  // the server flips it OPS_APPROVED → DISPATCHING once ops approve.
  PENDING_OPS:     {label: 'PENDING OPS', color: '#FBBF24', isActive: true,  needsAttention: false},
  OPS_APPROVED:    {label: 'APPROVED',    color: '#4ADE80', isActive: true,  needsAttention: true},
  PAYMENT_PENDING: {label: 'PAYMENT DUE', color: '#60A5FA', isActive: true,  needsAttention: true},
  CONFIRMED:       {label: 'CONFIRMED',   color: '#60A5FA', isActive: true,  needsAttention: false},
  LIVE:            {label: 'LIVE',        color: '#4ADE80', isActive: true,  needsAttention: false},
  COMPLETED:       {label: 'COMPLETED',   color: '#475569', isActive: false, needsAttention: false},
  CANCELLED:       {label: 'CANCELLED',   color: '#F87171', isActive: false, needsAttention: false},
  // Auto-dispatch terminal: nobody available. NOT an active booking (must not trap the
  // "one mission at a time" slot) — needsAttention so the home surfaces the fallback.
  NO_PROVIDER:     {label: 'NO DETAIL',   color: '#F5C76B', isActive: false, needsAttention: true},
  // LM-U4 — crew-SLA breach terminal: the agency accepted but never crewed; the
  // client was fully refunded. Rendered the grey UNKNOWN chip before this row.
  AGENCY_NO_SHOW:  {label: 'REFUNDED — AGENCY NO-SHOW', color: '#F5C76B', isActive: false, needsAttention: true},
};

export function describeStatus(raw: string | undefined | null): StatusDisplay {
  if (!raw) {return FALLBACK;}
  return CONFIG[raw.toUpperCase()] ?? FALLBACK;
}

// Bookings that should pull the user back into a flow on app re-entry.
// COMPLETED / CANCELLED are terminal — never resume those. DISPATCHING (auto search)
// resumes into the Finding screen. NO_PROVIDER is DELIBERATELY excluded — it is terminal
// and must not occupy the "one mission at a time" slot (the active-mission trap, LB17).
const RESUMABLE = new Set(['DISPATCHING', 'PENDING_OPS', 'OPS_APPROVED', 'PAYMENT_PENDING', 'CONFIRMED', 'LIVE']);

// Where to send the user for a given status. Anything not in this map is
// considered terminal and the user stays on the home screen.
export type ResumeTarget =
  | {screen: 'OpsRoomReview'; bookingId: string}
  | {screen: 'BookingConfirmation'; bookingId: string}
  | {screen: 'LiveTracking'; bookingId: string}
  | {screen: 'FindingDetail'; bookingId: string}
  | {screen: 'NoDetail'; bookingId: string};

// LB-OTP1 / LB-ST2 — the booking FSM stays CONFIRMED for the WHOLE mission
// (DISPATCHED → PICKUP → LIVE); only `mission_status` (surfaced on getById and,
// after the LB-ST1 fix, on the list) tracks the live phase. Any of these means a
// crew exists and is en route / on-site, so the user belongs on LiveTracking —
// NOT parked on the static BookingConfirmation (whose Track button was gated on
// booking.status === 'LIVE', a state that only arrives at go-live). This is the
// window in which the verify-guard (team) code is shown, so routing here is what
// makes the OTP reachable on resume + on a deep-link tap.
const MISSION_LIVE_STATES = new Set(['DISPATCHED', 'PICKUP', 'LIVE', 'SOS']);

export function resumeTargetFor(
  id: string,
  raw: string | undefined | null,
  missionRaw?: string | undefined | null,
): ResumeTarget | null {
  const s = (raw ?? '').toUpperCase();
  const ms = (missionRaw ?? '').toUpperCase();
  // A live mission wins over the (intentionally lagging) booking status.
  if (MISSION_LIVE_STATES.has(ms)) {return {screen: 'LiveTracking', bookingId: id};}
  if (s === 'DISPATCHING')  {return {screen: 'FindingDetail', bookingId: id};}
  if (s === 'PENDING_OPS' || s === 'OPS_APPROVED' || s === 'PAYMENT_PENDING') {
    return {screen: 'OpsRoomReview', bookingId: id};
  }
  if (s === 'CONFIRMED') {return {screen: 'BookingConfirmation', bookingId: id};}
  if (s === 'LIVE')      {return {screen: 'LiveTracking', bookingId: id};}
  if (s === 'NO_PROVIDER') {return {screen: 'NoDetail', bookingId: id};}
  return null;
}

// Convenience overload for callers holding a booking-ish object with both fields.
export function liveTargetFor(
  b: {id: string; status?: string | null; mission_status?: string | null},
): ResumeTarget | null {
  return resumeTargetFor(b.id, b.status, b.mission_status);
}

export function findResumableBooking<T extends {id: string; status?: unknown}>(
  bookings: readonly T[],
  excludeIds?: ReadonlySet<string>,
): T | undefined {
  return bookings.find(b => {
    if (excludeIds?.has(b.id)) {return false;}
    const s = typeof b.status === 'string' ? b.status.toUpperCase() : '';
    return RESUMABLE.has(s);
  });
}
