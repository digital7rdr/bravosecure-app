'use client';

import {useEffect, useState} from 'react';
import {useRouter} from 'next/navigation';
import {Shell} from '@/components/Shell';
import {ApiError, useOpsUsers} from '@/lib/api';
import {formatDateTimeUtc} from '@/lib/datetime';
import {roleLabel} from '@/lib/format';

// Why: chip labels map to the ACTUAL DB values — clients are role='individual'
// (not 'client') and a verified user is kyc_status='approved' (not 'verified'),
// so the old labels silently returned zero rows.
const ROLES: Array<{label: string; value?: string}> = [
  {label: 'All'},
  {label: 'Client', value: 'individual'},
  {label: 'Agent', value: 'agent'},
  {label: 'Provider', value: 'service_provider'},
];
const KYCS: Array<{label: string; value?: string}> = [
  {label: 'All KYC'},
  {label: 'None', value: 'none'},
  {label: 'Pending', value: 'pending'},
  {label: 'Verified', value: 'approved'},
];
const TIERS: Array<{label: string; value?: string}> = [
  {label: 'All Tiers'},
  {label: 'Lite', value: 'lite'},
  {label: 'Pro', value: 'pro'},
];

const LIMIT_MAX = 500;

const chipClass = (on: boolean) =>
  `rounded-md px-3 py-1.5 text-xs font-semibold capitalize ${
    on ? 'bg-zinc-700 text-zinc-100' : 'border border-zinc-700 text-zinc-400 hover:bg-zinc-800'
  }`;

export default function UsersPage() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [role, setRole] = useState<string | undefined>(undefined);
  const [kyc, setKyc] = useState<string | undefined>(undefined);
  const [tier, setTier] = useState<string | undefined>(undefined);
  const [limit, setLimit] = useState(100);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 400);
    return () => clearTimeout(t);
  }, [q]);

  const {data, isLoading, error} = useOpsUsers({
    q: debouncedQ || undefined,
    role,
    kyc,
    tier,
    limit,
  });

  const errText = error instanceof ApiError && error.status === 403
    ? 'Requires SUPERVISOR or ADMIN role.'
    : (error as Error | undefined)?.message;

  return (
    <Shell>
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-xl font-bold text-zinc-100">Users</h1>
          <p className="text-sm text-zinc-400">
            Platform user directory — clients, agents and service providers. Contact details stay on the
            detail page behind audited click-to-reveal.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search name / phone / email…"
            spellCheck={false}
            className="w-72 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
          />
          {ROLES.map(r => (
            <button key={r.label} onClick={() => setRole(r.value)} className={chipClass(role === r.value)}>
              {r.label}
            </button>
          ))}
          <span className="mx-1 text-zinc-700">|</span>
          {TIERS.map(t => (
            <button key={t.label} onClick={() => setTier(t.value)} className={chipClass(tier === t.value)}>
              {t.label}
            </button>
          ))}
          <span className="mx-1 text-zinc-700">|</span>
          {KYCS.map(k => (
            <button key={k.label} onClick={() => setKyc(k.value)} className={chipClass(kyc === k.value)}>
              {k.label}
            </button>
          ))}
        </div>

        {isLoading ? <p className="text-sm text-zinc-500">Loading…</p>
          : error ? <p className="text-sm text-red-400">{errText}</p>
          : (data?.length ?? 0) === 0 ? <p className="text-sm text-zinc-500">No users match this view.</p>
          : (
            <>
              <div className="overflow-hidden rounded-xl border border-zinc-800">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-900/60 text-left text-xs uppercase text-zinc-500">
                    <tr>
                      <th className="px-3 py-2">Display Name</th><th className="px-3 py-2">Role</th>
                      <th className="px-3 py-2">Tier</th><th className="px-3 py-2">KYC</th>
                      <th className="px-3 py-2">Region</th><th className="px-3 py-2">Credits</th>
                      <th className="px-3 py-2">Joined</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800">
                    {data!.map(u => (
                      <tr
                        key={u.id}
                        onClick={() => router.push(`/users/${u.id}`)}
                        className="cursor-pointer text-zinc-300 hover:bg-zinc-800/40">
                        <td className="px-3 py-2 text-zinc-100">
                          {u.display_name ?? '—'}
                          {u.deleted_at && (
                            <span className="ml-2 rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-red-400">
                              · deleted
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 capitalize">{roleLabel(u.role)}</td>
                        <td className="px-3 py-2">
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                            u.subscription_tier === 'pro'
                              ? 'bg-sky-500/15 text-sky-300'
                              : 'bg-zinc-700/40 text-zinc-400'
                          }`}>
                            {u.subscription_tier}
                          </span>
                        </td>
                        <td className="px-3 py-2 capitalize text-zinc-400">{u.kyc_status}</td>
                        <td className="px-3 py-2 text-zinc-400">{u.home_region ?? u.country_code ?? '—'}</td>
                        <td className="px-3 py-2 font-mono text-xs">
                          {u.bravo_credits != null ? `${u.bravo_credits.toLocaleString()} BC` : '—'}
                        </td>
                        <td className="px-3 py-2 text-zinc-400">{formatDateTimeUtc(u.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(data?.length ?? 0) >= limit && limit < LIMIT_MAX && (
                <button
                  onClick={() => setLimit(l => Math.min(l + 100, LIMIT_MAX))}
                  className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-300 hover:bg-zinc-800">
                  LOAD MORE
                </button>
              )}
            </>
          )}
      </div>
    </Shell>
  );
}
