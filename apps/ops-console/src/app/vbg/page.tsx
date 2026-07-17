'use client';

import {Shell} from '@/components/Shell';
import {Redacted} from '@/components/Redacted';
import {useVbgMonitoring, type VbgMonitoringRow} from '@/lib/api';
import {formatDateTimeUtc} from '@/lib/datetime';

function relAge(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '—';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return '<1m ago';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function isStale(r: VbgMonitoringRow): boolean {
  if (!r.last_heartbeat_at) return false;
  return Date.now() - new Date(r.last_heartbeat_at).getTime() > 2 * r.interval_min * 60_000;
}

function riskOf(r: VbgMonitoringRow): string {
  const parts = [
    r.risk_score != null ? String(r.risk_score) : null,
    r.sra_level,
  ].filter((v): v is string => v != null);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function Tile({label, value, cls}: {label: string; value: number; cls: string}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className={`text-2xl font-bold ${cls}`}>{value}</div>
      <div className="mt-1 text-xs uppercase tracking-wide text-zinc-500">{label}</div>
    </div>
  );
}

export default function VbgMonitoringPage() {
  const {data, isLoading, error} = useVbgMonitoring();
  const rows = data ?? [];

  return (
    <Shell>
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-xl font-bold text-zinc-100">VBG Monitoring</h1>
          <p className="text-sm text-zinc-400">
            VBG is the self-monitoring protectee product — protectees check in on a heartbeat schedule
            from their own device. This is the ops welfare/escalation view: read-only oversight of
            heartbeat health, zone state and escalations.
          </p>
        </div>

        {isLoading ? <p className="text-sm text-zinc-500">Loading…</p>
          : error ? <p className="text-sm text-red-400">{(error as Error).message}</p>
          : rows.length === 0 ? <p className="text-sm text-zinc-500">No VBG enrollments.</p>
          : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Tile label="Enrolled" value={rows.length} cls="text-zinc-100" />
                <Tile label="Active" value={rows.filter(r => r.status.toLowerCase() === 'active').length} cls="text-emerald-400" />
                <Tile label="Escalated" value={rows.filter(r => r.escalated_at != null).length} cls="text-red-400" />
                <Tile label="Stale Heartbeat" value={rows.filter(isStale).length} cls="text-amber-400" />
              </div>

              <div className="overflow-hidden rounded-xl border border-zinc-800">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-900/60 text-left text-xs uppercase text-zinc-500">
                    <tr>
                      <th className="px-3 py-2">Protectee</th><th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2">Heartbeat</th><th className="px-3 py-2">Missed</th>
                      <th className="px-3 py-2">Zone</th><th className="px-3 py-2">Escalated</th>
                      <th className="px-3 py-2">Risk</th><th className="px-3 py-2">Last Fix</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800">
                    {rows.map(r => (
                      <tr key={r.user_id} className={`text-zinc-300 ${r.escalated_at ? 'bg-red-500/5' : ''}`}>
                        <td className="px-3 py-2">
                          <div className="text-zinc-100">{r.display_name ?? '—'}</div>
                          <div className="text-xs text-zinc-500">
                            <Redacted value={r.phone_e164} kind="phone" subject={r.user_id} />
                          </div>
                        </td>
                        <td className="px-3 py-2 capitalize text-zinc-400">{r.status.replace(/_/g, ' ')}</td>
                        <td className={`px-3 py-2 font-mono text-xs ${isStale(r) ? 'font-semibold text-red-400' : 'text-zinc-400'}`}>
                          {r.last_heartbeat_at ? `${relAge(r.last_heartbeat_at)} / ${r.interval_min}m` : '—'}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-zinc-400">
                          {r.missed_count} / {r.consecutive_fails}
                        </td>
                        <td className="px-3 py-2 capitalize text-zinc-400">{r.last_zone_state ?? '—'}</td>
                        <td className={`px-3 py-2 ${r.escalated_at ? 'font-semibold text-red-400' : 'text-zinc-500'}`}>
                          {r.escalated_at ? formatDateTimeUtc(r.escalated_at) : '—'}
                        </td>
                        <td className="px-3 py-2 text-zinc-400">{riskOf(r)}</td>
                        <td className="px-3 py-2 font-mono text-xs text-zinc-400">{relAge(r.last_telemetry_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
      </div>
    </Shell>
  );
}
