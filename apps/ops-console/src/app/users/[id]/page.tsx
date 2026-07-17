'use client';

import {useState, type ReactNode} from 'react';
import Link from 'next/link';
import {useParams, useRouter} from 'next/navigation';
import {Shell} from '@/components/Shell';
import {Redacted} from '@/components/Redacted';
import {ApiError, opsDataApi, useOpsMe, useOpsUserDetail, type OpsUserDetail} from '@/lib/api';
import {formatDateTimeUtc} from '@/lib/datetime';
import {roleLabel} from '@/lib/format';

type DeviceRow = OpsUserDetail['devices'][number];

function deviceStatus(d: DeviceRow): 'ACTIVE' | 'REVOKED' | 'EXPIRED' {
  if (d.revoked_at) return 'REVOKED';
  if (d.expires_at && new Date(d.expires_at).getTime() < Date.now()) return 'EXPIRED';
  return 'ACTIVE';
}

const DEVICE_STATE_CLASS: Record<string, string> = {
  ACTIVE: 'text-emerald-400',
  REVOKED: 'text-red-400',
  EXPIRED: 'text-zinc-500',
};

function Card({title, right, flush, children}: {title: string; right?: ReactNode; flush?: boolean; children: ReactNode}) {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800">
      <div className="flex items-center justify-between bg-zinc-900/60 px-4 py-2.5">
        <div className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{title}</div>
        {right}
      </div>
      <div className={flush ? '' : 'p-4'}>{children}</div>
    </div>
  );
}

function Row({label, children}: {label: string; children: ReactNode}) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-2 py-1 text-sm">
      <div className="pt-0.5 text-xs uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="break-all text-zinc-200">{children}</div>
    </div>
  );
}

/**
 * M1A/S9 — inline subscription-tier editor (comp grants / support fixes).
 * Days blank = permanent grant (RS-17); 'lite' also cancels every renewal
 * path server-side so a live card sub can't silently re-upgrade the user.
 */
function TierEditor({user, onChanged}: {user: OpsUserDetail['user']; onChanged: () => void}) {
  const [tier, setTier] = useState<'lite' | 'pro' | 'enterprise'>(
    (['lite', 'pro', 'enterprise'].includes(user.subscription_tier) ? user.subscription_tier : 'lite') as 'lite' | 'pro' | 'enterprise',
  );
  const [days, setDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty = tier !== user.subscription_tier || days !== '';

  async function apply() {
    setBusy(true); setErr(null);
    try {
      const parsed = days.trim() === '' ? null : Number(days);
      if (parsed !== null && (!Number.isInteger(parsed) || parsed < 1 || parsed > 3650)) {
        setErr('Days must be 1–3650, or blank for a permanent grant.');
        return;
      }
      await opsDataApi.setUserTier(user.id, {tier, days: parsed});
      setDays('');
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Tier change failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={tier}
        onChange={e => setTier(e.target.value as 'lite' | 'pro' | 'enterprise')}
        disabled={busy}
        className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs capitalize text-zinc-200">
        <option value="lite">lite</option>
        <option value="pro">pro</option>
        <option value="enterprise">enterprise</option>
      </select>
      {tier !== 'lite' && (
        <input
          value={days}
          onChange={e => setDays(e.target.value)}
          disabled={busy}
          placeholder="days (blank = permanent)"
          className="w-44 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600"
        />
      )}
      <button
        onClick={() => { void apply(); }}
        disabled={busy || !dirty}
        className="rounded-md border border-sky-500/40 px-3 py-1 text-xs font-semibold text-sky-400 hover:bg-sky-500/10 disabled:opacity-40">
        {busy ? 'APPLYING…' : 'APPLY'}
      </button>
      {user.pro_active_until && (
        <span className="text-xs text-zinc-500">until {formatDateTimeUtc(user.pro_active_until)}</span>
      )}
      {err && <span className="text-xs text-red-400">{err}</span>}
    </div>
  );
}

export default function UserDetailPage() {
  const {id} = useParams<{id: string}>();
  const router = useRouter();
  const {data, isLoading, error, mutate} = useOpsUserDetail(id);
  const {data: me} = useOpsMe();
  const role = me?.admin.role;
  const canRevoke = !!role && role !== 'OPS';
  const canErase = role === 'ADMIN';
  const [busyDevice, setBusyDevice] = useState<string | null>(null);
  const [deviceErr, setDeviceErr] = useState<string | null>(null);
  const [acctBusy, setAcctBusy] = useState(false);
  const [acctErr, setAcctErr] = useState<string | null>(null);

  async function revoke(rowId: string) {
    if (busyDevice) return;
    if (!window.confirm('Revoke this session? The device will be signed out and must authenticate again.')) return;
    setBusyDevice(rowId);
    setDeviceErr(null);
    try {
      await opsDataApi.revokeUserDevice(id, rowId);
      await mutate();
    } catch (e) {
      setDeviceErr((e as Error).message);
    } finally {
      setBusyDevice(null);
    }
  }

  async function runAccountAction(fn: () => Promise<unknown>) {
    if (acctBusy) return;
    setAcctBusy(true);
    setAcctErr(null);
    try {
      await fn();
      await mutate();
    } catch (e) {
      setAcctErr((e as Error).message);
    } finally {
      setAcctBusy(false);
    }
  }

  function suspend() {
    const reason = window.prompt('Suspend reason (locks login + signs out all devices):');
    if (!reason || reason.trim().length < 3) return;
    void runAccountAction(() => opsDataApi.suspendUser(id, reason.trim()));
  }

  function restore() {
    if (!window.confirm('Lift the suspension and allow this user to sign in again?')) return;
    void runAccountAction(() => opsDataApi.restoreUser(id));
  }

  function erase() {
    const reason = window.prompt(
      'IRREVERSIBLE ERASURE. This scrubs name/email/phone/avatar and permanently blocks login (booking/wallet history is retained for audit). Type the reason to confirm:',
    );
    if (!reason || reason.trim().length < 3) return;
    if (!window.confirm('This cannot be undone. Erase this user now?')) return;
    void runAccountAction(() => opsDataApi.eraseUser(id, reason.trim()));
  }

  if (isLoading) {
    return <Shell><p className="p-6 text-sm text-zinc-500">Loading…</p></Shell>;
  }
  if (error || !data) {
    const msg = error instanceof ApiError && error.status === 403
      ? 'Requires SUPERVISOR or ADMIN role.'
      : ((error as Error | undefined)?.message ?? 'User not found.');
    return <Shell><p className="p-6 text-sm text-red-400">{msg}</p></Shell>;
  }

  const {user, devices, balance, bookings, agent} = data;

  return (
    <Shell>
      <div className="space-y-6 p-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-xl font-bold text-zinc-100">
              {user.display_name ?? user.id.slice(0, 8)}
              {user.deleted_at && (
                <span className="ml-2 rounded bg-red-500/10 px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase text-red-400">
                  deleted {formatDateTimeUtc(user.deleted_at)}
                </span>
              )}
              {!user.deleted_at && user.suspended_at && (
                <span className="ml-2 rounded bg-amber-500/10 px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase text-amber-400">
                  suspended {formatDateTimeUtc(user.suspended_at)}
                </span>
              )}
            </h1>
            <p className="text-sm text-zinc-400">User record, wallet, sessions and recent bookings.</p>
          </div>
          <div className="flex items-center gap-2">
            {canRevoke && !user.deleted_at && (
              user.suspended_at ? (
                <button onClick={restore} disabled={acctBusy}
                  className="rounded-md border border-emerald-500/40 px-3 py-1.5 text-xs font-semibold text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-50">
                  RESTORE
                </button>
              ) : (
                <button onClick={suspend} disabled={acctBusy}
                  className="rounded-md border border-amber-500/40 px-3 py-1.5 text-xs font-semibold text-amber-400 hover:bg-amber-500/10 disabled:opacity-50">
                  SUSPEND
                </button>
              )
            )}
            {canErase && !user.deleted_at && (
              <button onClick={erase} disabled={acctBusy}
                className="rounded-md border border-red-500/40 px-3 py-1.5 text-xs font-semibold text-red-400 hover:bg-red-500/10 disabled:opacity-50">
                ERASE
              </button>
            )}
            <Link href="/users" className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-300 hover:bg-zinc-800">
              ← BACK
            </Link>
          </div>
        </div>
        {acctErr && <p className="text-sm text-red-400">{acctErr}</p>}
        {user.suspended_at && user.suspended_reason && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2 text-sm text-amber-300">
            Suspended: {user.suspended_reason}
          </div>
        )}

        <Card title="Profile">
          <Row label="Display Name">{user.display_name ?? '—'}</Row>
          <Row label="Role"><span className="capitalize">{roleLabel(user.role)}</span></Row>
          <Row label="Tier"><TierEditor user={user} onChanged={() => { void mutate(); }} /></Row>
          <Row label="KYC"><span className="capitalize">{user.kyc_status}</span></Row>
          <Row label="Region">{user.home_region ?? user.country_code ?? '—'}</Row>
          <Row label="Lang / Currency">{user.language ?? '—'} / {user.currency ?? '—'}</Row>
          <Row label="Phone"><Redacted value={user.phone_e164} kind="phone" subject={user.id} /></Row>
          <Row label="Email"><Redacted value={user.email} kind="email" subject={user.id} /></Row>
          <Row label="Created">{formatDateTimeUtc(user.created_at)}</Row>
          <Row label="ID"><span className="font-mono text-xs text-zinc-400">{user.id}</span></Row>
        </Card>

        <Card title="Wallet">
          <Row label="Balance">
            {balance ? `${balance.bravo_credits.toLocaleString()} BC` : '—'}
          </Row>
          <Row label="Updated">{balance ? formatDateTimeUtc(balance.updated_at) : '—'}</Row>
          <p className="mt-2 text-xs text-zinc-500">
            Balance changes go through <Link href="/finance" className="text-sky-400 hover:underline">adjust via Finance</Link>.
          </p>
        </Card>

        <Card title="Devices / Sessions" right={<span className="text-xs text-zinc-500">{devices.length}</span>} flush>
          {deviceErr && <p className="px-4 pt-3 text-sm text-red-400">{deviceErr}</p>}
          {devices.length === 0 ? (
            <p className="p-4 text-sm text-zinc-500">No sessions on record.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-zinc-900/60 text-left text-xs uppercase text-zinc-500">
                <tr>
                  <th className="px-3 py-2">Platform</th><th className="px-3 py-2">Device</th>
                  <th className="px-3 py-2">Signal</th><th className="px-3 py-2">Last Used</th>
                  <th className="px-3 py-2">Expires</th><th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {devices.map(d => {
                  const state = deviceStatus(d);
                  return (
                    <tr key={d.id} className="text-zinc-300">
                      <td className="px-3 py-2 capitalize">{d.platform ?? '—'}</td>
                      <td className="px-3 py-2 font-mono text-xs text-zinc-400" title={d.device_id}>
                        {d.device_id.length > 16 ? `${d.device_id.slice(0, 16)}…` : d.device_id}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-zinc-400">{d.signal_device_id ?? '—'}</td>
                      <td className="px-3 py-2 text-zinc-400">{formatDateTimeUtc(d.last_used_at)}</td>
                      <td className="px-3 py-2 text-zinc-400">{formatDateTimeUtc(d.expires_at)}</td>
                      <td className={`px-3 py-2 font-semibold ${DEVICE_STATE_CLASS[state]}`}>{state}</td>
                      <td className="px-3 py-2 text-right">
                        {canRevoke && state === 'ACTIVE' && (
                          <button
                            onClick={() => revoke(d.id)}
                            disabled={busyDevice === d.id}
                            className="rounded-md border border-red-500/40 px-2 py-1 text-[10px] font-semibold text-red-400 hover:bg-red-500/10 disabled:opacity-50">
                            {busyDevice === d.id ? 'REVOKING…' : 'REVOKE'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Recent Bookings" right={<span className="text-xs text-zinc-500">{bookings.length}</span>} flush>
          {bookings.length === 0 ? (
            <p className="p-4 text-sm text-zinc-500">No bookings on record.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-zinc-900/60 text-left text-xs uppercase text-zinc-500">
                <tr>
                  <th className="px-3 py-2">Status</th><th className="px-3 py-2">Service</th>
                  <th className="px-3 py-2">Region</th><th className="px-3 py-2">Pickup</th>
                  <th className="px-3 py-2">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {bookings.map(b => (
                  <tr
                    key={b.id}
                    onClick={() => router.push(`/bookings/${b.id}`)}
                    className="cursor-pointer text-zinc-300 hover:bg-zinc-800/40">
                    <td className="px-3 py-2 uppercase text-zinc-400">{b.status.replace(/_/g, ' ')}</td>
                    <td className="px-3 py-2 capitalize">{b.service.replace(/_/g, ' ')}</td>
                    <td className="px-3 py-2 text-zinc-400">{b.region_code}</td>
                    <td className="px-3 py-2 text-zinc-400">{formatDateTimeUtc(b.pickup_time)}</td>
                    <td className="px-3 py-2 font-mono text-xs">{parseFloat(b.total_eur).toLocaleString()} BC</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {agent && (
          <Card
            title="Agent Record"
            right={
              <Link href={`/agents/${agent.user_id}`} className="text-xs font-semibold text-sky-400 hover:underline">
                VIEW AGENT →
              </Link>
            }>
            <Row label="Call Sign">{agent.call_sign ?? '—'}</Row>
            <Row label="Type"><span className="uppercase">{agent.type}</span></Row>
            <Row label="Status"><span className="uppercase">{agent.status.replace(/_/g, ' ')}</span></Row>
            <Row label="On Duty">{agent.on_duty ? <span className="text-emerald-400">YES</span> : 'NO'}</Row>
          </Card>
        )}
      </div>
    </Shell>
  );
}
