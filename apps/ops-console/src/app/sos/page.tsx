'use client';

import {useState} from 'react';
import Link from 'next/link';
import {Shell} from '@/components/Shell';
import {opsApi, useOpsMe, useSosEvents, type SosEventRow} from '@/lib/api';
import {formatDateTimeUtc} from '@/lib/datetime';

const STATUSES = ['active', 'resolved', 'all'] as const;
type SosFilter = (typeof STATUSES)[number];

const ESCALATE_TARGETS = ['POLICE', 'EMBASSY', 'CLIENT_FAMILY', 'OTHER'] as const;

type SosState = 'RESOLVED' | 'ESCALATED' | 'ACKED' | 'UNACKED';

function stateOf(r: SosEventRow): SosState {
  if (r.resolved_at) return 'RESOLVED';
  if (r.escalated_at) return 'ESCALATED';
  if (r.acknowledged_at) return 'ACKED';
  return 'UNACKED';
}

const STATE_CLASS: Record<SosState, string> = {
  RESOLVED: 'text-emerald-400',
  ESCALATED: 'text-red-400',
  ACKED: 'text-sky-400',
  UNACKED: 'animate-pulse text-red-400',
};

export default function SosPage() {
  const [status, setStatus] = useState<SosFilter>('active');
  const {data, isLoading, error, mutate} = useSosEvents(status);
  const {data: me} = useOpsMe();
  const supervisor = me?.admin.role === 'SUPERVISOR' || me?.admin.role === 'ADMIN';
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [escalateTo, setEscalateTo] = useState<Record<string, string>>({});

  async function run(id: string, fn: () => Promise<unknown>) {
    if (busyId) return;
    setBusyId(id);
    setActionErr(null);
    try {
      await fn();
      await mutate();
    } catch (e) {
      setActionErr((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  function escalate(r: SosEventRow) {
    const target = escalateTo[r.id] ?? 'POLICE';
    if (!window.confirm(`Escalate this SOS to ${target}?`)) return;
    void run(r.id, () => opsApi.escalateSos(r.id, target));
  }

  function resolve(r: SosEventRow) {
    const text = window.prompt('Resolution (min 3 characters):');
    if (text === null) return;
    if (text.trim().length < 3) {
      setActionErr('Resolution must be at least 3 characters.');
      return;
    }
    void run(r.id, () => opsApi.resolveSos(r.id, text.trim()));
  }

  return (
    <Shell>
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-xl font-bold text-zinc-100">SOS Event Log</h1>
          <p className="text-sm text-zinc-400">
            Every SOS on the platform — including mission-less client/VBG panic events which have no
            mission drill-down. Unacknowledged events pulse red until an operator acks them.
          </p>
        </div>

        <div className="flex gap-2">
          {STATUSES.map(s => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold uppercase ${
                status === s ? 'bg-zinc-700 text-zinc-100' : 'border border-zinc-700 text-zinc-400 hover:bg-zinc-800'
              }`}>
              {s}
            </button>
          ))}
        </div>

        {actionErr && <p className="text-sm text-red-400">{actionErr}</p>}

        {isLoading ? <p className="text-sm text-zinc-500">Loading…</p>
          : error ? <p className="text-sm text-red-400">{(error as Error).message}</p>
          : (data?.length ?? 0) === 0 ? <p className="text-sm text-zinc-500">No SOS events in this view.</p>
          : (
            <div className="overflow-hidden rounded-xl border border-zinc-800">
              <table className="w-full text-sm">
                <thead className="bg-zinc-900/60 text-left text-xs uppercase text-zinc-500">
                  <tr>
                    <th className="px-3 py-2">Triggered</th><th className="px-3 py-2">Who</th>
                    <th className="px-3 py-2">Reason</th><th className="px-3 py-2">Mission</th>
                    <th className="px-3 py-2">Region</th><th className="px-3 py-2">Position</th>
                    <th className="px-3 py-2">State</th><th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {data!.map(r => {
                    const state = stateOf(r);
                    return (
                      <tr key={r.id} className="text-zinc-300">
                        <td className="px-3 py-2 text-zinc-400">{formatDateTimeUtc(r.triggered_at)}</td>
                        <td className="px-3 py-2 text-zinc-100">{r.agent_call_sign ?? r.user_display_name ?? '—'}</td>
                        <td className="px-3 py-2 text-zinc-400">{r.reason ?? '—'}</td>
                        <td className="px-3 py-2">
                          {r.mission_id ? (
                            <Link href={`/live/${r.mission_id}`} className="font-mono text-xs text-sky-300 hover:underline">
                              {r.mission_short_code ?? r.mission_id.slice(0, 8)}
                            </Link>
                          ) : (
                            <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-400">
                              PANIC
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-zinc-400">{r.region_label ?? '—'}</td>
                        <td className="px-3 py-2 font-mono text-xs text-zinc-400">
                          {r.lat != null && r.lng != null ? `${r.lat.toFixed(4)}, ${r.lng.toFixed(4)}` : '—'}
                        </td>
                        <td className={`px-3 py-2 font-semibold ${STATE_CLASS[state]}`}>{state}</td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            {!r.acknowledged_at && (
                              <button
                                onClick={() => void run(r.id, () => opsApi.ackSos(r.id))}
                                disabled={busyId === r.id}
                                className="rounded-md border border-sky-500/40 px-2 py-1 text-[10px] font-semibold text-sky-400 hover:bg-sky-500/10 disabled:opacity-50">
                                ACK
                              </button>
                            )}
                            {supervisor && r.acknowledged_at && !r.escalated_at && !r.resolved_at && (
                              <>
                                <select
                                  value={escalateTo[r.id] ?? 'POLICE'}
                                  onChange={e => setEscalateTo(p => ({...p, [r.id]: e.target.value}))}
                                  className="rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-[10px] text-zinc-300">
                                  {ESCALATE_TARGETS.map(t => <option key={t} value={t}>{t}</option>)}
                                </select>
                                <button
                                  onClick={() => escalate(r)}
                                  disabled={busyId === r.id}
                                  className="rounded-md border border-red-500/40 px-2 py-1 text-[10px] font-semibold text-red-400 hover:bg-red-500/10 disabled:opacity-50">
                                  ESCALATE
                                </button>
                              </>
                            )}
                            {supervisor && !r.resolved_at && (
                              <button
                                onClick={() => resolve(r)}
                                disabled={busyId === r.id}
                                className="rounded-md border border-emerald-500/40 px-2 py-1 text-[10px] font-semibold text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-50">
                                RESOLVE
                              </button>
                            )}
                          </div>
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
