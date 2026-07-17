/**
 * Audit P1 follow-up (mid-call video upgrade regression) — the
 * runtime's `handleServerFrame` dispatcher gate that decides whether
 * to route a frame through `callDispatcher`. Extracted to a tiny
 * pure function so a unit test can lock in the exact event list
 * without standing up the full runtime.
 *
 * History: this gate originally listed only `call.offer / call.answer
 * / call.ice / call.hangup` (the initial-call set). Later additions
 * (`call.media-state` for peer-mute, `call.reoffer` / `call.reanswer`
 * for mid-call SDP renegotiation) had to be threaded in here as well
 * or the frames would silently fall through and the corresponding
 * UX would hang — voice→video upgrades stalled ~8s then rolled back
 * because the reanswer never reached the dispatcher.
 *
 * Add a new frame name here AND the matching `case` in
 * `callDispatcher.ts`. Forget either side and the frame is dropped.
 */
export const CALL_FRAME_EVENTS = new Set<string>([
  // ─── Initial 1:1 call lifecycle ─────────────────────────────────
  'call.offer',
  'call.answer',
  'call.ice',
  'call.hangup',
  // ─── Mid-call control / renegotiation ───────────────────────────
  // BS-021 — peer-mute / peer-camera-off advisory.
  'call.media-state',
  // Mid-call SDP renegotiation (voice → video upgrade, codec change,
  // bandwidth-driven track replacement). Gateway emits these and the
  // dispatcher handles them, but if this gate doesn't route them the
  // upgrade hangs ~8s then rolls back.
  'call.reoffer',
  'call.reanswer',
  // Audit SFU-12 — server tells the callee about a 1:1 offer that expired
  // while they were offline (the caller gave up) so we can render a
  // "Missed call" record instead of the call vanishing without a trace.
  'call.missed',
]);

export function isCallFrame(eventName: string): boolean {
  return CALL_FRAME_EVENTS.has(eventName);
}
