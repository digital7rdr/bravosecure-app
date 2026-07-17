'use client';

import {useState} from 'react';
import {Shell} from '@/components/Shell';
import {useCompliancePending, useOpsMe, opsApi, opsDataApi} from '@/lib/api';
import {canReviewCompliance} from '@/lib/rbac';

// Audit PAGE-18 — floor, not round: a doc that expired up to 12h ago used
// to round to 0 and render amber "0d" instead of red "expired".
function daysToExpiry(iso: string): number {
  return Math.floor((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

export default function CompliancePage() {
  const {data, isLoading, error, mutate} = useCompliancePending();
  const {data: me} = useOpsMe();
  const canReview = canReviewCompliance(me?.admin.role);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const act = async (id: string, fn: () => Promise<unknown>, label: string) => {
    setBusy(id); setMsg(null);
    try { await fn(); setMsg(`${label} done.`); await mutate(); }
    catch (e) { setMsg(`Failed: ${(e as Error).message}`); }
    finally { setBusy(null); }
  };

  // DC-03 — armed permits live on armed_authorizations and use their own
  // verify/reject endpoints; credential rows keep the compliance ones.
  const verify = (id: string, armed: boolean) =>
    void act(id, () => (armed ? opsDataApi.verifyArmed(id) : opsApi.verifyCompliance(id)), 'Verify');

  const reject = (id: string, armed: boolean) => {
    const reason = window.prompt('Reject reason (shown to the provider):');
    if (!reason) return;
    void act(id, () => (armed ? opsDataApi.rejectArmed(id, reason) : opsApi.rejectCompliance(id, reason)), 'Reject');
  };

  return (
    <Shell>
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-xl font-bold text-zinc-100">Compliance Review</h1>
          <p className="text-sm text-zinc-400">Verify provider licence / insurance / armed-permit docs. A provider is NOT dispatch-eligible until verified.</p>
        </div>
        {/* Audit PAGE-18 — colour failures red so a failed verify isn't missed. */}
        {msg && <p role="alert" className={`text-sm ${msg.startsWith('Failed:') ? 'text-red-400' : 'text-zinc-300'}`}>{msg}</p>}
        {!canReview && (
          <p className="text-xs text-zinc-500">Read-only — verifying / rejecting compliance docs requires Supervisor or Admin.</p>
        )}

        {isLoading ? <p className="text-sm text-zinc-500">Loading…</p>
          : error ? <p className="text-sm text-red-400">{(error as Error).message}</p>
          : (data?.length ?? 0) === 0 ? <p className="text-sm text-zinc-500">No pending compliance docs. 🎉</p>
          : (
            <div className="overflow-hidden rounded-xl border border-zinc-800">
              <table className="w-full text-sm">
                <thead className="bg-zinc-900/60 text-left text-xs uppercase text-zinc-500">
                  <tr>
                    <th className="px-3 py-2">Type</th><th className="px-3 py-2">Provider</th>
                    <th className="px-3 py-2">Region</th><th className="px-3 py-2">Ref</th>
                    <th className="px-3 py-2">Expires</th><th className="px-3 py-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {data!.map(r => {
                    const dte = daysToExpiry(r.expires_at);
                    return (
                      <tr key={r.id} className="text-zinc-300">
                        <td className="px-3 py-2 font-semibold uppercase text-amber-400">
                          {r.doc_type}
                          {r.armed && <span className="ml-2 rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-bold text-red-400">ARMED</span>}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">{r.subject_user_id.slice(0, 8)}</td>
                        <td className="px-3 py-2">{r.region_code}</td>
                        <td className="px-3 py-2 text-zinc-400">{r.reference ?? '—'}</td>
                        <td className={`px-3 py-2 ${dte < 0 ? 'text-red-400' : dte < 30 ? 'text-amber-400' : 'text-zinc-400'}`}>
                          {dte < 0 ? 'expired' : `${dte}d`}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {/* Audit PAGE-18 — hide verify/reject from OPS-tier (server is SUPERVISOR+). */}
                          {canReview ? (
                            <>
                              <button disabled={busy === r.id}
                                onClick={() => verify(r.id, r.armed)}
                                className="mr-2 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
                                Verify
                              </button>
                              <button disabled={busy === r.id} onClick={() => reject(r.id, r.armed)}
                                className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-300 hover:bg-zinc-800 disabled:opacity-50">
                                Reject
                              </button>
                            </>
                          ) : (
                            <span className="text-xs text-zinc-600">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </div>
    </Shell>
  );
}
