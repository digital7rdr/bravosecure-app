'use client';

import {useMemo, useState} from 'react';
import Link from 'next/link';
import {Shell} from '@/components/Shell';
import {
  ApiError, opsApi, opsDataApi, useOpsMe,
  useDisputes, useFinanceEscrows, useFinanceInvoices, useFinancePayouts,
  useFinancePromos, useFinanceTransactions, useWalletOverview,
  type FinanceTxRow,
} from '@/lib/api';
import {canAdjustWallet, canResolveDispute} from '@/lib/rbac';
import {formatDateTimeUtc} from '@/lib/datetime';
import {roleLabel} from '@/lib/format';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CREDITS_MAX = 100_000;

const TABS = ['LEDGER', 'ESCROW', 'PAYOUTS', 'DISPUTES', 'INVOICES', 'PROMOS', 'ADJUST'] as const;
type Tab = (typeof TABS)[number];

const TX_TYPES = ['all', 'topup', 'payment', 'refund', 'payout', 'expire', 'escrow_hold', 'escrow_refund', 'escrow_release'] as const;
const ESCROW_STATUSES = ['all', 'HELD', 'RELEASED', 'REFUNDED', 'SPLIT'] as const;

const fmt = formatDateTimeUtc;

function errText(e: unknown): string {
  if (e instanceof ApiError && e.status === 403) return 'Requires SUPERVISOR or ADMIN role.';
  return (e as Error).message;
}

function creditsClass(type: string, amount: number): string {
  if (type === 'topup' || type === 'refund' || type === 'escrow_refund') return 'text-emerald-400';
  if (amount < 0 || type === 'payment' || type === 'escrow_hold' || type === 'expire') return 'text-red-400';
  return 'text-zinc-300';
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

function downloadCsv(filename: string, header: string[], rows: unknown[][]) {
  const body = [header, ...rows].map(r => r.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob([body], {type: 'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

const th = 'px-3 py-2';
const tableWrap = 'overflow-x-auto rounded-xl border border-zinc-800';
const thead = 'bg-zinc-900/60 text-left text-xs uppercase text-zinc-500';
const chip = (on: boolean) =>
  `rounded-md px-3 py-1.5 text-xs font-semibold ${on ? 'bg-zinc-700 text-zinc-100' : 'border border-zinc-700 text-zinc-400 hover:bg-zinc-800'}`;

function Panel({loading, error, empty, children}: {
  loading: boolean; error: unknown; empty: boolean; children: React.ReactNode;
}) {
  if (loading) return <p className="text-sm text-zinc-500">Loading…</p>;
  if (error)   return <p className="text-sm text-red-400">{errText(error)}</p>;
  if (empty)   return <p className="text-sm text-zinc-500">Nothing here yet.</p>;
  return <>{children}</>;
}

function LedgerTab() {
  const [type, setType] = useState<string>('all');
  const [limit, setLimit] = useState(50);
  const {data, isLoading, error} = useFinanceTransactions({type: type === 'all' ? undefined : type, limit});
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {TX_TYPES.map(t => (
          <button key={t} onClick={() => setType(t)} className={chip(type === t)}>{t.replace(/_/g, ' ')}</button>
        ))}
        <div className="flex-1" />
        <button
          onClick={() => data && downloadCsv(
            `wallet_ledger_${new Date().toISOString().slice(0, 10)}.csv`,
            ['created_at', 'user', 'user_id', 'type', 'status', 'credits', 'fiat_cents', 'fiat_ccy', 'description', 'booking_id', 'settled_at'],
            data.map(r => [r.created_at, r.display_name, r.user_id, r.type, r.status, r.amount_credits, r.amount_fiat_cents, r.fiat_currency, r.description, r.booking_id, r.settled_at]),
          )}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-300 hover:bg-zinc-800">
          EXPORT CSV
        </button>
      </div>
      <Panel loading={isLoading} error={error} empty={(data?.length ?? 0) === 0}>
        <div className={tableWrap}>
          <table className="w-full text-sm">
            <thead className={thead}>
              <tr>
                <th className={th}>Time</th><th className={th}>User</th><th className={th}>Type</th>
                <th className={th}>Status</th><th className={`${th} text-right`}>Credits</th>
                <th className={th}>Fiat</th><th className={th}>Description</th><th className={th}>Booking</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {(data ?? []).map((r: FinanceTxRow) => (
                <tr key={r.id} className="text-zinc-300">
                  <td className={`${th} whitespace-nowrap text-zinc-400`}>{fmt(r.created_at)}</td>
                  <td className={th}>
                    <div>{r.display_name ?? '—'}</div>
                    <div className="font-mono text-[10px] text-zinc-600">{r.user_id.slice(0, 8)}</div>
                  </td>
                  <td className={`${th} font-mono text-xs`}>{r.type}</td>
                  <td className={`${th} text-xs ${r.status === 'succeeded' ? 'text-emerald-400' : r.status === 'failed' ? 'text-red-400' : 'text-amber-400'}`}>{r.status}</td>
                  <td className={`${th} text-right font-mono font-semibold ${creditsClass(r.type, r.amount_credits)}`}>
                    {r.amount_credits.toLocaleString()} BC
                  </td>
                  <td className={`${th} text-xs text-zinc-500`}>
                    {r.amount_fiat_cents != null ? `${(r.amount_fiat_cents / 100).toFixed(2)} ${r.fiat_currency ?? ''}` : '—'}
                  </td>
                  <td className={`${th} max-w-[260px] truncate text-zinc-400`} title={r.description ?? ''}>{r.description ?? '—'}</td>
                  <td className={th}>
                    {r.booking_id
                      ? <Link href={`/bookings/${r.booking_id}`} className="font-mono text-xs text-sky-300 hover:underline">{r.booking_id.slice(0, 8)}</Link>
                      : <span className="text-zinc-600">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(data?.length ?? 0) >= limit && limit < 200 && (
          <button onClick={() => setLimit(l => Math.min(l + 50, 200))}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-300 hover:bg-zinc-800">
            LOAD MORE
          </button>
        )}
      </Panel>
    </div>
  );
}

function EscrowTab() {
  const [status, setStatus] = useState<string>('all');
  const {data, isLoading, error} = useFinanceEscrows(status === 'all' ? undefined : status);
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {ESCROW_STATUSES.map(s => <button key={s} onClick={() => setStatus(s)} className={chip(status === s)}>{s}</button>)}
      </div>
      <Panel loading={isLoading} error={error} empty={(data?.length ?? 0) === 0}>
        <div className={tableWrap}>
          <table className="w-full text-sm">
            <thead className={thead}>
              <tr>
                <th className={th}>Held</th><th className={th}>Booking</th><th className={th}>Region</th>
                <th className={th}>Client</th><th className={th}>Provider</th>
                <th className={`${th} text-right`}>Gross</th><th className={`${th} text-right`}>Split P/C/Fee</th>
                <th className={th}>Status</th><th className={th}>Settled</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {(data ?? []).map(r => (
                <tr key={r.id} className={`text-zinc-300 ${r.review_required && !r.settled_at ? 'bg-amber-500/5' : ''}`}>
                  <td className={`${th} whitespace-nowrap text-zinc-400`}>{fmt(r.held_at)}</td>
                  <td className={th}>
                    <Link href={`/bookings/${r.booking_id}`} className="font-mono text-xs text-sky-300 hover:underline">{r.booking_id.slice(0, 8)}</Link>
                    <div className="text-[10px] text-zinc-600">{r.booking_status}</div>
                  </td>
                  <td className={th}>{r.region_code}</td>
                  <td className={`${th} text-zinc-400`}>{r.client_name ?? '—'}</td>
                  <td className={`${th} text-zinc-400`}>{r.provider_name ?? '—'}</td>
                  <td className={`${th} text-right font-mono font-semibold`}>{r.gross_credits.toLocaleString()} BC</td>
                  <td className={`${th} text-right font-mono text-xs text-zinc-400`}>
                    {r.settled_at ? `${r.to_provider_credits ?? 0}/${r.to_client_credits ?? 0}/${r.platform_fee_credits ?? 0}` : '—'}
                  </td>
                  <td className={th}>
                    <span className={r.status === 'HELD' ? 'text-amber-400' : r.status === 'REFUNDED' ? 'text-red-400' : 'text-emerald-400'}>{r.status}</span>
                    {r.review_required && !r.settled_at && <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-400">REVIEW</span>}
                  </td>
                  <td className={`${th} whitespace-nowrap text-zinc-500`}>{r.settled_at ? fmt(r.settled_at) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function PayoutsTab() {
  const {data, isLoading, error} = useFinancePayouts();
  return (
    <Panel loading={isLoading} error={error} empty={(data?.length ?? 0) === 0}>
      <div className={tableWrap}>
        <table className="w-full text-sm">
          <thead className={thead}>
            <tr>
              <th className={th}>Decided</th><th className={th}>Payee</th><th className={th}>Mission</th>
              <th className={th}>Region</th><th className={`${th} text-right`}>Proposed</th>
              <th className={`${th} text-right`}>Paid</th><th className={th}>Deduction</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {(data ?? []).map(r => (
              <tr key={r.id} className="text-zinc-300">
                <td className={`${th} whitespace-nowrap text-zinc-400`}>{r.decided_at ? fmt(r.decided_at) : '—'}</td>
                <td className={th}>
                  <div>{r.payee_name ?? r.call_sign ?? '—'}</div>
                  <div className="font-mono text-[10px] text-zinc-600">{r.call_sign ?? ''}</div>
                </td>
                <td className={th}>
                  {r.mission_short_code && r.mission_id
                    ? <Link href={`/live/${r.mission_id}`} className="font-mono text-xs text-sky-300 hover:underline">{r.mission_short_code}</Link>
                    : <span className="text-zinc-600">—</span>}
                </td>
                <td className={th}>{r.region_code ?? '—'}</td>
                <td className={`${th} text-right font-mono text-zinc-400`}>{r.proposed_credits?.toLocaleString() ?? '—'}</td>
                <td className={`${th} text-right font-mono font-semibold text-emerald-400`}>{r.paid_credits?.toLocaleString() ?? '—'} BC</td>
                <td className={`${th} text-xs text-zinc-500`}>
                  {r.deduction_credits ? `−${r.deduction_credits} · ${r.deduction_reason ?? ''}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function DisputesTab({canResolve}: {canResolve: boolean}) {
  const {data, isLoading, error, mutate} = useDisputes();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const resolve = async (id: string, gross: number | null) => {
    const toClient = window.prompt(`Credits back TO CLIENT (escrow gross: ${gross ?? '?'} BC):`, '0');
    if (toClient === null) return;
    const toProvider = window.prompt('Credits TO PROVIDER:', '0');
    if (toProvider === null) return;
    const resolution = window.prompt('Resolution note (required):');
    if (!resolution || resolution.trim().length < 3) return;
    const tc = Number(toClient), tp = Number(toProvider);
    if (!Number.isInteger(tc) || !Number.isInteger(tp) || tc < 0 || tp < 0) { setMsg('Failed: splits must be non-negative integers.'); return; }
    if (!window.confirm(`Resolve dispute:\n  client ← ${tc} BC\n  provider ← ${tp} BC\n\n${resolution.trim()}`)) return;
    setBusy(id); setMsg(null);
    try {
      await opsDataApi.resolveDispute(id, {to_client: tc, to_provider: tp, resolution: resolution.trim()});
      setMsg('Dispute resolved.');
      await mutate();
    } catch (e) { setMsg(`Failed: ${errText(e)}`); }
    finally { setBusy(null); }
  };

  return (
    <div className="space-y-3">
      {msg && <p role="alert" className={`text-sm ${msg.startsWith('Failed:') ? 'text-red-400' : 'text-zinc-300'}`}>{msg}</p>}
      <Panel loading={isLoading} error={error} empty={(data?.length ?? 0) === 0}>
        <div className={tableWrap}>
          <table className="w-full text-sm">
            <thead className={thead}>
              <tr>
                <th className={th}>Raised</th><th className={th}>Booking</th><th className={th}>Region</th>
                <th className={th}>By</th><th className={th}>Category</th><th className={th}>Reason</th>
                <th className={th}>Escrow</th><th className={th}>Status</th><th className={`${th} text-right`}>Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {(data ?? []).map(r => (
                <tr key={r.id} className={`text-zinc-300 ${r.status === 'OPEN' ? 'bg-red-500/5' : ''}`}>
                  <td className={`${th} whitespace-nowrap text-zinc-400`}>{fmt(r.created_at)}</td>
                  <td className={th}>
                    <Link href={`/bookings/${r.booking_id}`} className="font-mono text-xs text-sky-300 hover:underline">{r.booking_id.slice(0, 8)}</Link>
                  </td>
                  <td className={th}>{r.region_code}</td>
                  <td className={`${th} text-zinc-400`}>{r.raised_by_name ?? '—'}</td>
                  <td className={`${th} capitalize`}>{r.category?.replace(/_/g, ' ') ?? '—'}</td>
                  <td className={`${th} max-w-[220px] truncate text-zinc-400`} title={r.reason ?? ''}>{r.reason ?? '—'}</td>
                  <td className={`${th} font-mono text-xs text-zinc-400`}>
                    {r.escrow_status ?? '—'}{r.gross_credits != null ? ` · ${r.gross_credits} BC` : ''}
                  </td>
                  <td className={th}>
                    <span className={r.status === 'OPEN' ? 'font-semibold text-red-400' : 'text-emerald-400'}>{r.status}</span>
                    {r.decided_at && <div className="text-[10px] text-zinc-600">{fmt(r.decided_at)}</div>}
                  </td>
                  <td className={`${th} text-right`}>
                    {r.status === 'OPEN' && canResolve ? (
                      <button disabled={busy === r.id} onClick={() => void resolve(r.id, r.gross_credits)}
                        className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
                        Resolve
                      </button>
                    ) : <span className="text-xs text-zinc-600">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function InvoicesTab() {
  const {data, isLoading, error} = useFinanceInvoices();
  return (
    <Panel loading={isLoading} error={error} empty={(data?.length ?? 0) === 0}>
      <div className={tableWrap}>
        <table className="w-full text-sm">
          <thead className={thead}>
            <tr>
              <th className={th}>Number</th><th className={th}>Issued</th><th className={th}>Kind</th>
              <th className={th}>Region</th><th className={th}>Booking</th>
              <th className={`${th} text-right`}>Subtotal</th><th className={`${th} text-right`}>Tax</th>
              <th className={`${th} text-right`}>Total</th><th className={th}>PDF</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {(data ?? []).map(r => (
              <tr key={r.id} className="text-zinc-300">
                <td className={`${th} font-mono text-xs text-sky-300`}>{r.invoice_number}</td>
                <td className={`${th} whitespace-nowrap text-zinc-400`}>{fmt(r.issued_at)}</td>
                <td className={`${th} text-xs uppercase`}>{r.kind}</td>
                <td className={th}>{r.region_code ?? '—'}</td>
                <td className={th}>
                  {r.booking_id
                    ? <Link href={`/bookings/${r.booking_id}`} className="font-mono text-xs text-sky-300 hover:underline">{r.booking_id.slice(0, 8)}</Link>
                    : '—'}
                </td>
                <td className={`${th} text-right font-mono`}>{r.subtotal_credits.toLocaleString()}</td>
                <td className={`${th} text-right font-mono text-zinc-500`}>{r.tax_credits.toLocaleString()}</td>
                <td className={`${th} text-right font-mono font-semibold`}>{r.total_credits.toLocaleString()} {r.currency}</td>
                <td className={th}>
                  {r.pdf_url ? <a href={r.pdf_url} target="_blank" rel="noreferrer" className="text-xs text-sky-300 hover:underline">open</a> : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function PromosTab() {
  const {data, isLoading, error} = useFinancePromos();
  return (
    <Panel loading={isLoading} error={error} empty={(data?.length ?? 0) === 0}>
      <div className={tableWrap}>
        <table className="w-full text-sm">
          <thead className={thead}>
            <tr>
              <th className={th}>Code</th><th className={`${th} text-right`}>Credits</th>
              <th className={`${th} text-right`}>Redemptions</th><th className={th}>Expires</th>
              <th className={th}>Active</th><th className={th}>Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {(data ?? []).map(r => (
              <tr key={r.id} className="text-zinc-300">
                <td className={`${th} font-mono font-semibold text-sky-300`}>{r.code}</td>
                <td className={`${th} text-right font-mono`}>{r.credits.toLocaleString()} BC</td>
                <td className={`${th} text-right font-mono text-zinc-400`}>{r.redeemed_count}{r.max_redemptions ? ` / ${r.max_redemptions}` : ''}</td>
                <td className={`${th} text-zinc-400`}>{r.expires_at ? fmt(r.expires_at) : '—'}</td>
                <td className={th}>{r.active ? <span className="text-emerald-400">yes</span> : <span className="text-zinc-600">no</span>}</td>
                <td className={`${th} whitespace-nowrap text-zinc-500`}>{fmt(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function AdjustTab({canAdjust}: {canAdjust: boolean}) {
  const [userId, setUserId] = useState('');
  const [credits, setCredits] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{balance: number; txId: string} | null>(null);

  const validUuid = UUID_RE.test(userId.trim());
  // Why: the DC-01 fix — the adjust form gets ledger context, so credits are
  // never moved against a wallet the operator hasn't just looked at.
  const {data: overview, error: overviewErr} = useWalletOverview(validUuid ? userId.trim() : null);

  const creditsNum = Number(credits);
  const creditsOk = credits.trim() !== '' && Number.isInteger(creditsNum) &&
    creditsNum !== 0 && Math.abs(creditsNum) <= CREDITS_MAX;
  const valid = validUuid && creditsOk && reason.trim().length >= 3;

  async function submit() {
    if (busy || !valid) return;
    const verb = creditsNum > 0 ? 'CREDIT' : 'DEDUCT';
    const prep = creditsNum > 0 ? 'to' : 'from';
    const who = overview ? `${overview.user.display_name ?? 'user'} (${overview.balance.bravo_credits.toLocaleString()} BC now)` : userId.trim();
    if (!window.confirm(
      `${verb} ${Math.abs(creditsNum).toLocaleString()} BC ${prep} wallet of\n${who}\n\nReason: ${reason.trim()}\n\nThis writes to the wallet ledger immediately and cannot be undone from here.`,
    )) return;
    setBusy(true); setErr(null); setDone(null);
    try {
      const r = await opsApi.adjustWallet(userId.trim(), {credits: creditsNum, reason: reason.trim()});
      setDone({balance: r.balance.bravo_credits, txId: r.transaction_id});
      setCredits(''); setReason('');
    } catch (e) { setErr(errText(e)); }
    finally { setBusy(false); }
  }

  if (!canAdjust) {
    return <p className="text-sm text-zinc-500">Credit adjustments require SUPERVISOR or ADMIN.</p>;
  }

  const input = 'w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-100 placeholder:text-zinc-600';
  const label = 'mb-1.5 text-[10px] font-bold uppercase tracking-widest text-zinc-500';

  return (
    <div className="flex flex-wrap items-start gap-4">
      <div className="w-[420px] space-y-3 rounded-xl border border-zinc-800 p-4">
        <div>
          <div className={label}>User ID (UUID)</div>
          <input className={input} value={userId} onChange={e => setUserId(e.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000" spellCheck={false} />
        </div>
        <div>
          <div className={label}>Credits (± integer, max {CREDITS_MAX.toLocaleString()})</div>
          <input className={input} value={credits} onChange={e => setCredits(e.target.value)}
            placeholder="e.g. 500 or -250" inputMode="numeric" />
        </div>
        <div>
          <div className={label}>Reason (required)</div>
          <textarea className={`${input} min-h-[64px] resize-none font-sans`} value={reason}
            onChange={e => setReason(e.target.value)} placeholder="Why this adjustment is being made…" />
        </div>
        <button disabled={busy || !valid} onClick={() => void submit()}
          className="w-full rounded-md bg-emerald-600 px-3 py-2 text-xs font-bold text-white hover:bg-emerald-500 disabled:opacity-50">
          {busy ? 'ADJUSTING…' : 'APPLY ADJUSTMENT'}
        </button>
        {err && <p className="text-xs text-red-400">✗ {err}</p>}
        {done && (
          <div className="rounded-lg border border-emerald-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-300">
            ✓ Applied. New balance <b className="text-zinc-100">{done.balance.toLocaleString()} BC</b>
            <div className="font-mono text-[10px] text-zinc-600">{done.txId}</div>
          </div>
        )}
        <p className="text-[10px] leading-relaxed text-zinc-600">
          Every adjustment is written to the wallet ledger with the acting admin and reason — there are no silent balance changes.
        </p>
      </div>

      <div className="min-w-[380px] flex-1 rounded-xl border border-zinc-800 p-4">
        {!validUuid ? <p className="text-sm text-zinc-500">Enter a user UUID to see their wallet before adjusting.</p>
          : overviewErr ? <p className="text-sm text-red-400">{errText(overviewErr)}</p>
          : !overview ? <p className="text-sm text-zinc-500">Loading wallet…</p>
          : (
            <div className="space-y-3">
              <div className="flex items-baseline justify-between">
                <div>
                  <div className="text-sm font-semibold text-zinc-100">{overview.user.display_name ?? '—'}</div>
                  <div className="text-xs text-zinc-500">{roleLabel(overview.user.role)} · KYC {overview.user.kyc_status} · {overview.user.subscription_tier}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-lg font-bold text-emerald-400">{overview.balance.bravo_credits.toLocaleString()} BC</div>
                  <div className="text-[10px] text-zinc-600">{overview.balance.updated_at ? fmt(overview.balance.updated_at) : ''}</div>
                </div>
              </div>
              <div>
                <div className={label}>Recent ledger</div>
                <div className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
                  {overview.transactions.length === 0 && <p className="px-3 py-2 text-xs text-zinc-500">No transactions.</p>}
                  {overview.transactions.slice(0, 10).map(t => (
                    <div key={t.id} className="flex items-center justify-between px-3 py-1.5 text-xs">
                      <span className="text-zinc-500">{fmt(t.created_at)}</span>
                      <span className="font-mono text-zinc-400">{t.type}</span>
                      <span className={`font-mono font-semibold ${creditsClass(t.type, t.amount_credits)}`}>{t.amount_credits.toLocaleString()} BC</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
      </div>
    </div>
  );
}

export default function Finance() {
  const {data: me} = useOpsMe();
  const role = me?.admin.role;
  const canAdjust = canAdjustWallet(role);
  const canResolve = canResolveDispute(role);
  const [tab, setTab] = useState<Tab>('LEDGER');

  const tabs = useMemo(() => TABS, []);

  return (
    <Shell>
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-xl font-bold text-zinc-100">Finance</h1>
          <p className="text-sm text-zinc-400">
            Wallet ledger, escrow settlement, payouts, disputes, invoices and promos — read straight from the money tables.
            Ledger reads require SUPERVISOR+.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {tabs.map(t => <button key={t} onClick={() => setTab(t)} className={chip(tab === t)}>{t}</button>)}
        </div>

        {tab === 'LEDGER'   && <LedgerTab />}
        {tab === 'ESCROW'   && <EscrowTab />}
        {tab === 'PAYOUTS'  && <PayoutsTab />}
        {tab === 'DISPUTES' && <DisputesTab canResolve={canResolve} />}
        {tab === 'INVOICES' && <InvoicesTab />}
        {tab === 'PROMOS'   && <PromosTab />}
        {tab === 'ADJUST'   && <AdjustTab canAdjust={canAdjust} />}
      </div>
    </Shell>
  );
}
