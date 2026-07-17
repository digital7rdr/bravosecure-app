import {BadRequestException} from '@nestjs/common';
import {AgentService} from './agent.service';
import {AgentStateMachine} from './state-machine.service';
import type {DatabaseService} from '../database/database.service';
import type {RedisService} from '../redis/redis.service';
import type {CpoAssignmentService} from '../booking/assignment/cpo-assignment.service';
import type {WalletService} from '../wallet/wallet.service';
import type {DepartmentService} from '../department/department.service';
import type {ProofOfCompletionService} from './proof-of-completion.service';
import type {ConfigService} from '@nestjs/config';

/**
 * Bug 3 — setAgencyProfile stamps the agency's dispatch region_code + dpa_accepted_at
 * (the two is_eligible_for_dispatch / ranker inputs with no other UI). Company-only,
 * region allow-listed, DPA fail-closed, COALESCE preserves the first-accept time.
 */
function mk(agent: {type?: string} | null) {
  const calls: Array<{sql: string; params: unknown[]}> = [];
  const db = {
    q: jest.fn().mockResolvedValue([]),
    qOne: jest.fn().mockImplementation((sql: string, params: unknown[]) => {
      calls.push({sql, params});
      if (/UPDATE public\.agents/.test(sql)) {
        // RETURNING region_code, dpa_accepted_at — derive from the params the method passed.
        return Promise.resolve({
          region_code: params[1] as string,
          dpa_accepted_at: params[2] ? new Date('2026-01-01T00:00:00.000Z') : null,
        });
      }
      if (/FROM agents WHERE user_id/.test(sql)) {
        return Promise.resolve(agent ? {user_id: 'a1', status: 'ACTIVE', ...agent} : null);
      }
      return Promise.resolve(null);
    }),
  } as unknown as DatabaseService;
  const svc = new AgentService(
    db, new AgentStateMachine(),
    {} as unknown as RedisService, {} as unknown as CpoAssignmentService,
    {} as unknown as WalletService, {} as unknown as DepartmentService,
    {} as unknown as ProofOfCompletionService, {get: () => 0} as unknown as ConfigService,
  );
  return {svc, calls};
}
const updCall = (calls: Array<{sql: string; params: unknown[]}>) =>
  calls.find(c => /UPDATE public\.agents/.test(c.sql))!;

describe('AgentService.setAgencyProfile (Bug 3 — region + DPA)', () => {
  it('stamps region_code (upper-cased) + dpa_accepted_at when dpa_accepted=true', async () => {
    const {svc, calls} = mk({type: 'company'});
    const r = await svc.setAgencyProfile('a1', {region_code: 'bd', dpa_accepted: true});
    expect(r.region_code).toBe('BD');
    expect(r.dpa_accepted_at).not.toBeNull();
    const upd = updCall(calls);
    expect(upd.params[1]).toBe('BD');   // upper-cased region
    expect(upd.params[2]).toBe(true);   // dpa boolean (fail-closed: only literal true)
    expect(upd.sql).toMatch(/COALESCE\(dpa_accepted_at, NOW\(\)\)/); // first-accept time preserved
  });

  it('does NOT stamp dpa when dpa_accepted=false (fail-closed)', async () => {
    const {svc, calls} = mk({type: 'company'});
    const r = await svc.setAgencyProfile('a1', {region_code: 'AE', dpa_accepted: false});
    expect(r.dpa_accepted_at).toBeNull();
    expect(updCall(calls).params[2]).toBe(false);
  });

  it('rejects a non-company agent', async () => {
    const {svc} = mk({type: 'cpo'});
    await expect(svc.setAgencyProfile('a1', {region_code: 'BD', dpa_accepted: true}))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unsupported region', async () => {
    const {svc} = mk({type: 'company'});
    await expect(svc.setAgencyProfile('a1', {region_code: 'XX', dpa_accepted: true}))
      .rejects.toThrow('unsupported_region');
  });
});
