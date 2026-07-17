'use client';

import {useState} from 'react';
import {Shell} from '@/components/Shell';
import {useDeptIncidents} from '@/lib/api';
import {formatDateTimeUtc} from '@/lib/datetime';

const SEVERITIES = ['all', 'critical', 'high', 'medium', 'low'] as const;
type Sev = (typeof SEVERITIES)[number];

const SEV_CLASS: Record<string, string> = {
  critical: 'text-red-400',
  high: 'text-amber-400',
  medium: 'text-sky-400',
  low: 'text-emerald-400',
};
const STATUS_LABEL: Record<string, string> = {
  submitted: 'Submitted', received: 'Received', under_review: 'Under Review',
  action_assigned: 'Action Assigned', resolved: 'Resolved', closed: 'Closed',
};

// Audit PAGE-09 — UTC-consistent with the rest of the console.
const fmt = formatDateTimeUtc;

export default function IncidentsOversightPage() {
  const [sev, setSev] = useState<Sev>('all');
  const {data, isLoading, error} = useDeptIncidents(sev === 'all' ? undefined : {severity: sev});

  return (
    <Shell>
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-xl font-bold text-zinc-100">Incident Oversight</h1>
          <p className="text-sm text-zinc-400">
            Cross-org incident reports (read-only HQ view). Submitter narratives, coordinates and evidence stay with
            the owning org — this surface shows status &amp; severity only.
          </p>
        </div>

        <div className="flex gap-2">
          {SEVERITIES.map(s => (
            <button
              key={s}
              onClick={() => setSev(s)}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold capitalize ${
                sev === s ? 'bg-zinc-700 text-zinc-100' : 'border border-zinc-700 text-zinc-400 hover:bg-zinc-800'
              }`}>
              {s}
            </button>
          ))}
        </div>

        {isLoading ? <p className="text-sm text-zinc-500">Loading…</p>
          : error ? <p className="text-sm text-red-400">{(error as Error).message}</p>
          : (data?.length ?? 0) === 0 ? <p className="text-sm text-zinc-500">No incidents in this view.</p>
          : (
            <div className="overflow-hidden rounded-xl border border-zinc-800">
              <table className="w-full text-sm">
                <thead className="bg-zinc-900/60 text-left text-xs uppercase text-zinc-500">
                  <tr>
                    <th className="px-3 py-2">Ref</th><th className="px-3 py-2">Category</th>
                    <th className="px-3 py-2">Severity</th><th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Org</th><th className="px-3 py-2">Updated</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {data!.map(r => (
                    <tr key={r.id} className="text-zinc-300">
                      <td className="px-3 py-2 font-mono text-xs text-sky-300">{r.ref ?? '—'}</td>
                      <td className="px-3 py-2 capitalize">{r.category.replace(/_/g, ' ')}</td>
                      <td className={`px-3 py-2 font-semibold uppercase ${SEV_CLASS[r.severity] ?? 'text-zinc-400'}`}>{r.severity}</td>
                      <td className="px-3 py-2 text-zinc-400">{STATUS_LABEL[r.status] ?? r.status}</td>
                      <td className="px-3 py-2 font-mono text-xs text-zinc-500">{r.org_user_id.slice(0, 8)}</td>
                      <td className="px-3 py-2 text-zinc-400">{fmt(r.updated_at)}</td>
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
