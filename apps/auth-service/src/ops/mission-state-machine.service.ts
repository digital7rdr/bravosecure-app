import {ForbiddenException, Injectable} from '@nestjs/common';

/**
 * Mission lifecycle — active execution of a confirmed booking.
 *
 *   DISPATCHED → PICKUP → LIVE → COMPLETED
 *
 * Any LIVE/PICKUP mission can escalate to SOS (CPO triggers red alert
 * from the mobile app). From SOS we can recover back to LIVE (false
 * alarm / cleared), complete normally, or get ABORTED by Ops.
 *
 * Any non-terminal state can be ABORTED by Ops / Admin.
 */
export type MissionStatus =
  | 'DISPATCHED'
  | 'PICKUP'
  | 'LIVE'
  | 'SOS'
  | 'COMPLETED'
  | 'ABORTED';

export type MissionActor = 'AGENT' | 'OPS' | 'ADMIN' | 'SYSTEM';

interface MT {from: MissionStatus; to: MissionStatus; actor: MissionActor}

const TRANSITIONS: MT[] = [
  // Crew moves the mission forward from the mobile side.
  {from: 'DISPATCHED', to: 'PICKUP',    actor: 'AGENT'},
  {from: 'PICKUP',     to: 'LIVE',      actor: 'AGENT'},
  {from: 'LIVE',       to: 'COMPLETED', actor: 'AGENT'},

  // SOS can be raised from PICKUP or LIVE by the agent on the ground.
  {from: 'PICKUP', to: 'SOS', actor: 'AGENT'},
  {from: 'LIVE',   to: 'SOS', actor: 'AGENT'},
  // Or escalated by Ops watching the feed.
  {from: 'PICKUP', to: 'SOS', actor: 'OPS'},
  {from: 'LIVE',   to: 'SOS', actor: 'OPS'},

  // SOS resolution paths — false alarm returns to LIVE, completion proceeds.
  {from: 'SOS', to: 'LIVE',      actor: 'OPS'},
  {from: 'SOS', to: 'LIVE',      actor: 'ADMIN'},
  {from: 'SOS', to: 'COMPLETED', actor: 'AGENT'},
  {from: 'SOS', to: 'COMPLETED', actor: 'OPS'},
  {from: 'SOS', to: 'COMPLETED', actor: 'ADMIN'},
];

// Abort is a universal escape hatch from any non-terminal state by Ops/Admin.
const ABORTABLE: readonly MissionStatus[] = ['DISPATCHED', 'PICKUP', 'LIVE', 'SOS'];
const ABORTING_ACTORS: readonly MissionActor[] = ['OPS', 'ADMIN'];

@Injectable()
export class MissionStateMachine {
  assert(from: MissionStatus, to: MissionStatus, actor: MissionActor): void {
    if (to === 'ABORTED') {
      if (!ABORTABLE.includes(from)) {
        throw new ForbiddenException(`Cannot abort mission in state ${from}`);
      }
      if (!ABORTING_ACTORS.includes(actor)) {
        throw new ForbiddenException(`Actor ${actor} cannot abort missions`);
      }
      return;
    }
    const ok = TRANSITIONS.some(t => t.from === from && t.to === to && t.actor === actor);
    if (!ok) {
      throw new ForbiddenException(
        `Invalid mission transition ${from} → ${to} for actor ${actor}`,
      );
    }
  }

  nextStates(from: MissionStatus, actor: MissionActor): MissionStatus[] {
    const forward = TRANSITIONS
      .filter(t => t.from === from && t.actor === actor)
      .map(t => t.to);
    if (ABORTABLE.includes(from) && ABORTING_ACTORS.includes(actor)) {
      forward.push('ABORTED');
    }
    return forward;
  }
}
