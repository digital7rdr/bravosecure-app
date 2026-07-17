'use client';

import {useEffect, useMemo, useState} from 'react';
import Link from 'next/link';
import {Shell} from '@/components/Shell';
import {ApiError, opsDataApi, useAuditBrowse, type OpsAuditRow} from '@/lib/api';
import {formatDateTimeUtc} from '@/lib/datetime';

const SUBJECT_TYPES = ['all', 'booking', 'mission', 'agent', 'user', 'job', 'application', 'pii', 'system', 'dispatch'] as const;
type SubjectType = (typeof SUBJECT_TYPES)[number];

const SUBJECT_HREF: Record<string, (id: string) => string> = {
  booking: id => `/bookings/${id}`,
  mission: id => `/live/${id}`,
  agent: id => `/agents/${id}`,
  user: id => `/users/${id}`,
};

const PAGE_SIZE = 100;

function csvCell(v: unknown): string {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

function SubjectRef({type, id}: {type: string | null; id: string | null}) {
  if (!type) return <span className="text-zinc-600">—</span>;
  const label = `${type}/${id ? id.slice(0, 8) : '—'}`;
  const href = id ? SUBJECT_HREF[type]?.(id) : undefined;
  return href
    ? <Link href={href} className="text-sky-400 hover:underline">{label}</Link>
    : <span>{label}</span>;
}

export default function AuditPage() {
  const [actionInput, setActionInput] = useState('');
  const [action, setAction] = useState('');
  const [subjectType, setSubjectType] = useState<SubjectType>('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [extra, setExtra] = useState<OpsAuditRow[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreErr, setMoreErr] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setAction(actionInput.trim()), 400);
    return () => clearTimeout(t);
  }, [actionInput]);

  const filters = useMemo(() => ({
    action: action || undefined,
    subject_type: subjectType === 'all' ? undefined : subjectType,
    from: fromDate ? `${fromDate}T00:00:00Z` : undefined,
    to: toDate ? `${toDate}T23:59:59Z` : undefined,
  }), [action, subjectType, fromDate, toDate]);

  useEffect(() => {
    setExtra([]);
    setExhausted(false);
    setMoreErr(null);
  }, [filters]);

  const {data, isLoading, error} = useAuditBrowse({...filters, limit: PAGE_SIZE});
  const rows = useMemo(() => [...(data ?? []), ...extra], [data, extra]);
  const maybeMore = !exhausted && (data?.length ?? 0) === PAGE_SIZE;
  const forbidden = error instanceof ApiError && error.status === 403;

  const loadOlder = async () => {
    const last = rows[rows.length - 1];
    if (!last || loadingMore) return;
    setLoadingMore(true);
    setMoreErr(null);
    try {
      const older = await opsDataApi.browseAudit({...filters, before: last.created_at, limit: PAGE_SIZE});
      setExtra(prev => [...prev, ...older]);
      if (older.length < PAGE_SIZE) setExhausted(true);
    } catch (e) {
      setMoreErr((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  const exportCsv = () => {
    const header = ['created_at', 'actor_call', 'actor_role', 'action', 'subject_type', 'subject_id', 'ip_address', 'metadata'];
    const lines = [header.map(csvCell).join(',')];
    for (const r of rows) {
      lines.push([
        r.created_at, r.actor_call, r.actor_role, r.action, r.subject_type,
        r.subject_id, r.ip_address, r.metadata ? JSON.stringify(r.metadata) : '',
      ].map(csvCell).join(','));
    }
    const blob = new Blob([lines.join('\n')], {type: 'text/csv'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit_export_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Shell>
      <div className="space-y-6 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-zinc-100">Audit Log</h1>
            <p className="text-sm text-zinc-400">Global admin action trail across bookings, missions, agents, users and system events. Newest first.</p>
          </div>
          <button
            onClick={exportCsv}
            disabled={rows.length === 0}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40">
            EXPORT CSV
          </button>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Action prefix
            <input
              value={actionInput}
              onChange={e => setActionInput(e.target.value)}
              placeholder="e.g. booking.approve"
              className="w-56 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-200 placeholder-zinc-600"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Subject type
            <select
              value={subjectType}
              onChange={e => setSubjectType(e.target.value as SubjectType)}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-200">
              {SUBJECT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            From
            <input
              type="date"
              value={fromDate}
              onChange={e => setFromDate(e.target.value)}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-2 text-xs text-zinc-200"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            To
            <input
              type="date"
              value={toDate}
              onChange={e => setToDate(e.target.value)}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-2 text-xs text-zinc-200"
            />
          </label>
        </div>

        {isLoading ? <p className="text-sm text-zinc-500">Loading…</p>
          : forbidden ? <p className="text-sm text-red-400">Requires SUPERVISOR or ADMIN role.</p>
          : error ? <p className="text-sm text-red-400">{(error as Error).message}</p>
          : rows.length === 0 ? <p className="text-sm text-zinc-500">No audit entries match these filters.</p>
          : (
            <>
              <div className="overflow-hidden rounded-xl border border-zinc-800">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-900/60 text-left text-xs uppercase text-zinc-500">
                    <tr>
                      <th className="px-3 py-2">Time</th><th className="px-3 py-2">Actor</th>
                      <th className="px-3 py-2">Action</th><th className="px-3 py-2">Subject</th>
                      <th className="px-3 py-2">IP</th><th className="px-3 py-2">Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800">
                    {rows.map(r => (
                      <tr key={r.id} className="align-top text-zinc-300">
                        <td className="whitespace-nowrap px-3 py-2 text-zinc-400">{formatDateTimeUtc(r.created_at)}</td>
                        <td className="px-3 py-2">
                          <div>{r.actor_call ?? r.actor_id?.slice(0, 8) ?? '—'}</div>
                          {r.actor_role && <div className="text-[10px] uppercase text-zinc-500">{r.actor_role}</div>}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-sky-300">{r.action}</td>
                        <td className="px-3 py-2 font-mono text-xs">
                          <SubjectRef type={r.subject_type} id={r.subject_id} />
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-zinc-500">{r.ip_address ?? '—'}</td>
                        <td className="px-3 py-2">
                          {r.metadata && Object.keys(r.metadata).length > 0 ? (
                            <details>
                              <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300">view</summary>
                              <pre className="mt-1 max-h-48 max-w-md overflow-auto rounded bg-zinc-900 p-2 text-[11px] leading-4 text-zinc-400">
                                {JSON.stringify(r.metadata, null, 2)}
                              </pre>
                            </details>
                          ) : <span className="text-zinc-700">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center gap-3">
                {maybeMore && (
                  <button
                    onClick={() => void loadOlder()}
                    disabled={loadingMore}
                    className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-400 hover:bg-zinc-800 disabled:opacity-40">
                    {loadingMore ? 'Loading…' : 'LOAD OLDER'}
                  </button>
                )}
                <span className="text-xs text-zinc-600">{rows.length} entries loaded</span>
                {moreErr && <span className="text-xs text-red-400">{moreErr}</span>}
              </div>
            </>
          )}
      </div>
    </Shell>
  );
}
