import {ComplianceService} from './compliance.service';
import type {DatabaseService} from '../database/database.service';

function mk(opts: {agentType?: string; verifyRow?: unknown; armedRow?: unknown} = {}) {
  const txQ = jest.fn().mockResolvedValue([]);
  const txQOne = jest.fn().mockResolvedValue({id: 'cred-1'});
  const tx = {q: txQ, qOne: txQOne};
  const db = {
    q: jest.fn().mockResolvedValue([]),
    qOne: jest.fn().mockImplementation((sql: string) => {
      if (/FROM public\.agents/.test(sql)) return Promise.resolve(opts.agentType ? {type: opts.agentType} : null);
      if (/UPDATE public\.compliance_credentials/.test(sql)) return Promise.resolve(opts.verifyRow ?? null);
      if (/UPDATE public\.armed_authorizations/.test(sql)) return Promise.resolve(opts.armedRow ?? null);
      return Promise.resolve(null);
    }),
    withTransaction: (fn: (t: unknown) => unknown) => fn(tx),
  } as unknown as DatabaseService;
  return {svc: new ComplianceService(db), db, tx, txQ, txQOne};
}

const FUTURE = new Date(Date.now() + 365 * 24 * 3600_000).toISOString();
const PAST = new Date(Date.now() - 1000).toISOString();

describe('ComplianceService', () => {
  it('submit licence inserts an UNVERIFIED compliance_credentials row (superseding prior pending)', async () => {
    const {svc, txQ, txQOne} = mk();
    const r = await svc.submit('agency-1', 'agency', {docType: 'licence', regionCode: 'AE', expiresAt: FUTURE, reference: 'LIC-9'});
    expect(r).toEqual({id: 'cred-1', doc_type: 'licence', state: 'PENDING'});
    expect(txQ).toHaveBeenCalledWith(expect.stringMatching(/DELETE FROM public\.compliance_credentials[\s\S]*NOT verified/), ['agency-1', 'licence', 'AE']);
    expect(txQOne).toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO public\.compliance_credentials[\s\S]*FALSE/), expect.arrayContaining(['agency-1', 'agency', 'licence', 'AE']));
  });

  it('submit armed_permit inserts an UN-authorized armed_authorizations row', async () => {
    const {svc, txQ} = mk();
    await svc.submit('cpo-1', 'cpo', {docType: 'armed_permit', regionCode: 'SA', expiresAt: FUTURE, reference: 'PERMIT-1'});
    expect(txQ).toHaveBeenCalledWith(expect.stringMatching(/DELETE FROM public\.armed_authorizations/), ['cpo-1', 'SA']);
  });

  it('rejects an expiry in the past', async () => {
    const {svc} = mk();
    await expect(svc.submit('a1', 'agency', {docType: 'licence', regionCode: 'AE', expiresAt: PAST})).rejects.toThrow('expiry_in_past');
  });

  it('submitForUser resolves a company agent to subject_kind=agency', async () => {
    const {svc, txQOne} = mk({agentType: 'company'});
    await svc.submitForUser('agency-1', {docType: 'insurance', regionCode: 'AE', expiresAt: FUTURE});
    expect(txQOne).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(['agency-1', 'agency', 'insurance']));
  });

  it('verify flips PENDING → VERIFIED and returns the subject', async () => {
    const {svc} = mk({verifyRow: {kind: 'licence', subject_user_id: 'agency-1'}});
    const r = await svc.verify('adm-1', 'cred-1');
    expect(r).toEqual({ok: true, doc_type: 'licence', subject_user_id: 'agency-1'});
  });

  it('verify is a no-op 404 when the credential is not PENDING (double-verify)', async () => {
    const {svc} = mk({verifyRow: null});
    await expect(svc.verify('adm-1', 'cred-1')).rejects.toThrow('credential_not_pending');
  });

  it('reject sets a reason (PENDING only)', async () => {
    const {svc, db} = mk();
    (db.qOne as jest.Mock).mockResolvedValueOnce({id: 'cred-1'}); // the UPDATE RETURNING
    const r = await svc.reject('adm-1', 'cred-1', 'expired cert');
    expect(r).toEqual({ok: true});
  });

  it('verifyArmed flips armed_authorizations.authorized', async () => {
    const {svc} = mk({armedRow: {cpo_user_id: 'cpo-1'}});
    const r = await svc.verifyArmed('adm-1', 'armed-1');
    expect(r).toEqual({ok: true, cpo_user_id: 'cpo-1'});
  });

  // Ops compliance review is NOT region-bounded (the ops controller passes no
  // admin.region) — a no-region call must return EVERY region's pending docs,
  // so e.g. an SA submission is visible to the (AE) ops admins.
  it('listPending with no region returns all regions (passes null)', async () => {
    const {svc, db} = mk();
    (db.q as jest.Mock).mockResolvedValueOnce([]);
    await svc.listPending();
    expect(db.q).toHaveBeenCalledWith(
      expect.stringMatching(/FROM public\.compliance_credentials[\s\S]*NOT verified[\s\S]*region_code = \$1/),
      [null],
    );
  });

  it('listPending(region) still filters to that region when one is explicitly given', async () => {
    const {svc, db} = mk();
    (db.q as jest.Mock).mockResolvedValueOnce([]);
    await svc.listPending('SA');
    expect(db.q).toHaveBeenCalledWith(expect.anything(), ['SA']);
  });
});
