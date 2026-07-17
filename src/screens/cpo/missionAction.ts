/**
 * missionAction (BUILD_RUNBOOK Step 21) — the pure selector for the CPO's ONE context-aware
 * mission button. Lead-only: a non-lead never gets an advance action (they ride along, read-
 * only, with chat + SOS). Maps the mission FSM state to the single next transition:
 *   DISPATCHED → Start    (agentApi.missionPickup,  DISPATCHED→PICKUP)
 *   PICKUP     → Go live   (agentApi.missionGoLive,  PICKUP→LIVE)
 *   LIVE       → Finish    (agentApi.missionComplete, LIVE→COMPLETED, deliberate confirm)
 *   SOS / COMPLETED / ABORTED / anything else → none
 * Pure → trivially unit-tested; the field screen renders exactly one button from this.
 */
export type MissionAction = 'start' | 'go-live' | 'finish' | 'none';

export interface MissionActionView {
  action: MissionAction;
  label: string;
  /** Require a deliberate swipe-to-confirm (Finish ends the mission + opens settlement). */
  confirm: boolean;
}

export function missionAction(status: string | null | undefined, isLead: boolean): MissionAction {
  if (!isLead) {return 'none';}
  switch ((status ?? '').toUpperCase()) {
    case 'DISPATCHED': return 'start';
    case 'PICKUP':     return 'go-live';
    case 'LIVE':       return 'finish';
    default:           return 'none'; // SOS / COMPLETED / ABORTED — no lead advance
  }
}

export function missionActionView(status: string | null | undefined, isLead: boolean): MissionActionView {
  const action = missionAction(status, isLead);
  switch (action) {
    case 'start':   return {action, label: 'Start mission', confirm: false};
    case 'go-live': return {action, label: 'Go live', confirm: false};
    case 'finish':  return {action, label: 'Finish mission', confirm: true};
    default:        return {action, label: '', confirm: false};
  }
}
