'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { Shell } from '@/components/Shell';
import { ApiError, opsDataApi, useOpsMe } from '@/lib/api';

/**
 * Audit fix 4.6 — Settings was a fake-form stub: a "SAVE CHANGES" button
 * with no handler, hardcoded "Session Timeout: 8 hours" (false — it's
 * 15 min per audit 4.1), and a tab rail that didn't render anything but
 * General. Rewritten as a read-only info card that reflects the real
 * console state. When we add real settings (notification prefs,
 * notification rules, integration tokens), each lands as its own page;
 * the tab rail comes back then.
 */
export default function Settings() {
  const {data: me} = useOpsMe();
  const admin = me?.admin;

  const fields: Array<[string, string]> = [
    ['Console Build',     'Bravo Ops Console · v1.0.0'],
    ['Your Call Sign',    admin?.call_sign ?? '—'],
    ['Your Role',         admin?.role      ?? '—'],
    ['Your Region',       admin?.region    ?? '—'],
    ['Session Timeout',   '15 minutes of inactivity'],
    ['Access Token',      'Rotates silently every 15 min via /auth/session/refresh'],
    ['2FA Requirement',   'Enforced via OTP at login'],
    ['CSRF Protection',   'Double-submit cookie + X-CSRF-Token header'],
    ['Idempotency',       '24h replay protection on approve / dispatch / complete / ack / decide / terminate'],
  ];

  return (
    <Shell>
      <div className="page-head">
        <div>
          <div className="page-crumbs">Ops · Settings</div>
          <h2>Console Settings</h2>
        </div>
      </div>
      <div className="card" style={{padding:24, overflow:'auto'}}>
        <div style={{fontFamily:'Manrope',fontSize:15,fontWeight:700,marginBottom:4}}>
          Read-only console info
        </div>
        <div style={{fontFamily:'JetBrains Mono',fontSize:10,color:'var(--tx-3)',marginBottom:20,letterSpacing:0.5}}>
          Values shown are enforced server-side. To change any of them, talk to engineering — there is no client-side toggle.
        </div>

        {fields.map(([label, val]) => (
          <div key={label} style={{
            display:'grid', gridTemplateColumns:'220px 1fr', gap:16,
            padding:'12px 0', borderBottom:'1px solid var(--bd-2)', alignItems:'center',
          }}>
            <div style={{
              fontFamily:'JetBrains Mono', fontSize:9.5, color:'var(--tx-3)',
              letterSpacing:1.2, textTransform:'uppercase', fontWeight:700,
            }}>
              {label}
            </div>
            <div style={{
              fontSize:12.5, color:'var(--tx-1)',
              fontFamily:'Manrope', fontWeight:500,
            }}>
              {val}
            </div>
          </div>
        ))}
      </div>

      <SubscriptionPricingCard />
    </Shell>
  );
}

/**
 * M1A/S9 — live subscription pricing (SUPERVISOR/ADMIN). Prices are read at
 * CHARGE TIME server-side, so a change applies to every subscribe and every
 * renewal from now on ("from next month" for renewing subscribers) while
 * already-paid periods finish at what they paid.
 */
function SubscriptionPricingCard() {
  const {data, mutate, error} = useSWR('ops-subscription-prices', () => opsDataApi.subscriptionPrices());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyTier, setBusyTier] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function save(tier: 'pro' | 'enterprise') {
    const raw = drafts[tier];
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000_000) {
      setErr('Price must be a whole number of BC between 1 and 1,000,000.');
      return;
    }
    setBusyTier(tier); setErr(null);
    try {
      await opsDataApi.setSubscriptionPrice(tier, parsed);
      setDrafts(d => ({...d, [tier]: ''}));
      await mutate();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Price update failed');
    } finally {
      setBusyTier(null);
    }
  }

  const label: Record<string, string> = {pro: 'Bravo Pro', enterprise: 'Enterprise'};

  return (
    <div className="card" style={{padding:24, marginTop:16, overflow:'auto'}}>
      <div style={{fontFamily:'Manrope',fontSize:15,fontWeight:700,marginBottom:4}}>
        Subscription pricing
      </div>
      <div style={{fontFamily:'JetBrains Mono',fontSize:10,color:'var(--tx-3)',marginBottom:20,letterSpacing:0.5}}>
        Charged at charge time — a change applies to every new subscribe and every renewal
        from now on; periods already paid finish at the old price. SUPERVISOR/ADMIN only.
      </div>
      {error && <div style={{fontSize:12,color:'#f87171',marginBottom:12}}>Could not load prices.</div>}
      {(data?.prices ?? []).map(p => (
        <div key={p.tier} style={{
          display:'grid', gridTemplateColumns:'220px 140px 160px 1fr', gap:16,
          padding:'12px 0', borderBottom:'1px solid var(--bd-2)', alignItems:'center',
        }}>
          <div style={{fontFamily:'JetBrains Mono',fontSize:9.5,color:'var(--tx-3)',letterSpacing:1.2,textTransform:'uppercase',fontWeight:700}}>
            {label[p.tier] ?? p.tier} / 30 days
          </div>
          <div style={{fontSize:12.5,color:'var(--tx-1)',fontFamily:'Manrope',fontWeight:700}}>
            {p.price_bc.toLocaleString()} BC
          </div>
          <input
            value={drafts[p.tier] ?? ''}
            onChange={e => setDrafts(d => ({...d, [p.tier]: e.target.value}))}
            placeholder="new price (BC)"
            style={{
              background:'transparent', border:'1px solid var(--bd-2)', borderRadius:6,
              padding:'6px 10px', fontSize:12, color:'var(--tx-1)', fontFamily:'JetBrains Mono',
            }}
          />
          <div>
            <button
              onClick={() => { void save(p.tier); }}
              disabled={busyTier === p.tier || !(drafts[p.tier] ?? '').trim()}
              style={{
                border:'1px solid rgba(56,189,248,0.4)', color:'#38bdf8', background:'transparent',
                borderRadius:6, padding:'6px 14px', fontSize:11, fontWeight:700, cursor:'pointer',
                opacity: busyTier === p.tier || !(drafts[p.tier] ?? '').trim() ? 0.4 : 1,
              }}>
              {busyTier === p.tier ? 'SAVING…' : 'SAVE'}
            </button>
          </div>
        </div>
      ))}
      {err && <div style={{fontSize:12,color:'#f87171',marginTop:12}}>{err}</div>}
    </div>
  );
}
