'use client';

import {useMemo, useState} from 'react';
import Link from 'next/link';
import {Shell} from '@/components/Shell';
import {useBroadcastsRecent} from '@/lib/api';
import {formatDateTimeUtc} from '@/lib/datetime';

const SEV_CLASS: Record<string, string> = {
  err: 'text-red-400',
  critical: 'text-red-400',
  warn: 'text-amber-400',
  info: 'text-zinc-400',
};

function truncateBody(body: string | null): string {
  if (!body) return '—';
  return body.length > 120 ? `${body.slice(0, 120)}…` : body;
}

function SubjectRef({type, id}: {type: string | null; id: string | null}) {
  if (!type) return <span className="text-zinc-600">—</span>;
  const label = `${type}/${id ? id.slice(0, 8) : '—'}`;
  const href = id && type === 'mission' ? `/live/${id}`
    : id && type === 'booking' ? `/bookings/${id}`
    : undefined;
  return href
    ? <Link href={href} className="text-sky-400 hover:underline">{label}</Link>
    : <span>{label}</span>;
}

export default function MessengerBroadcastsPage() {
  const [kind, setKind] = useState('all');
  const {data, isLoading, error} = useBroadcastsRecent(kind === 'all' ? undefined : kind);

  const kinds = useMemo(() => {
    const set = new Set<string>();
    // Why: with a kind filter active the API only returns that kind — keep
    // the selected chip in the list so it stays visible and deselectable.
    if (kind !== 'all') set.add(kind);
    for (const b of data ?? []) set.add(b.kind);
    return ['all', ...Array.from(set).sort()];
  }, [data, kind]);

  return (
    <Shell>
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-xl font-bold text-zinc-100">Messenger · System Broadcasts</h1>
          <p className="text-sm text-zinc-400">Platform-wide broadcast and system-event log (read-only).</p>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">
          Operator ↔ crew messaging lives in each mission&apos;s Ops Chat — open the mission under{' '}
          <Link href="/live" className="text-sky-400 hover:underline">/live</Link>. This page is the platform-wide
          broadcast/system-event log. A global composer is deliberately not offered yet (product decision pending).
        </div>

        <div className="flex flex-wrap gap-2">
          {kinds.map(k => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`rounded-md px-3 py-1.5 font-mono text-xs font-semibold ${
                kind === k ? 'bg-zinc-700 text-zinc-100' : 'border border-zinc-700 text-zinc-400 hover:bg-zinc-800'
              }`}>
              {k}
            </button>
          ))}
        </div>

        {isLoading ? <p className="text-sm text-zinc-500">Loading…</p>
          : error ? <p className="text-sm text-red-400">{(error as Error).message}</p>
          : (data?.length ?? 0) === 0 ? <p className="text-sm text-zinc-500">No broadcasts in this view.</p>
          : (
            <div className="overflow-hidden rounded-xl border border-zinc-800">
              <table className="w-full text-sm">
                <thead className="bg-zinc-900/60 text-left text-xs uppercase text-zinc-500">
                  <tr>
                    <th className="px-3 py-2">Time</th><th className="px-3 py-2">Kind</th>
                    <th className="px-3 py-2">Severity</th><th className="px-3 py-2">Title</th>
                    <th className="px-3 py-2">Body</th><th className="px-3 py-2">Subject</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {data!.map(b => (
                    <tr key={b.id} className="align-top text-zinc-300">
                      <td className="whitespace-nowrap px-3 py-2 text-zinc-400">{formatDateTimeUtc(b.created_at)}</td>
                      <td className="px-3 py-2 font-mono text-xs text-sky-300">{b.kind}</td>
                      <td className={`px-3 py-2 text-xs font-semibold uppercase ${SEV_CLASS[b.severity ?? ''] ?? 'text-zinc-400'}`}>
                        {b.severity ?? '—'}
                      </td>
                      <td className="px-3 py-2">{b.title ?? '—'}</td>
                      <td className="max-w-md px-3 py-2 text-zinc-400">{truncateBody(b.body)}</td>
                      <td className="px-3 py-2 font-mono text-xs">
                        <SubjectRef type={b.subject_type} id={b.subject_id} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>
    </Shell>
  );
}
