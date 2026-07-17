'use client';

import Link from 'next/link';
import {useState} from 'react';
import {Shell} from '@/components/Shell';
import {BravoMap, type BravoMarker} from '@/components/BravoMapLazy';
import {useMissions} from '@/lib/api';

function shortRoute(pickup: string | null, dropoff: string | null): string {
  const p = pickup?.split(',')[0]?.trim() ?? '—';
  const d = dropoff?.split(',')[0]?.trim() ?? '—';
  return `${p} → ${d}`;
}

export default function LiveOps() {
  const [tab, setTab] = useState<'active' | 'completed'>('active');
  // DC-09 — the completed tab was silently capped at 50 with no way to see
  // older missions; load-more raises the server limit (max 500).
  const [closedLimit, setClosedLimit] = useState(50);
  const {data: missions, isLoading, error} = useMissions(
    undefined, tab, tab === 'completed' ? closedLimit : undefined,
  );
  const [query, setQuery] = useState('');

  const all = (missions ?? []).map(m => ({
    id: m.id,
    short_code: m.short_code,
    booking_id: m.booking_id,
    client_name: m.client_display_name ?? '—',
    client_email: m.client_email ?? '',
    region: m.region_code ?? '—',
    route: shortRoute(m.pickup_address, m.dropoff_address),
    pickup: m.pickup_address ?? '—',
    dropoff: m.dropoff_address ?? '—',
    crew: '—',
    vehicle: m.vehicle_plate ?? '—',
    eta: m.current_lat ? 'live' : '—',
    status: m.status,
    lat: m.current_lat ?? undefined,
    lng: m.current_lng ?? undefined,
  }));

  const q = query.trim().toLowerCase();
  const rows = q
    ? all.filter(r =>
        r.client_name.toLowerCase().includes(q) ||
        r.client_email.toLowerCase().includes(q) ||
        r.short_code.toLowerCase().includes(q) ||
        r.booking_id.toLowerCase().includes(q) ||
        r.pickup.toLowerCase().includes(q) ||
        r.dropoff.toLowerCase().includes(q),
      )
    : all;

  const markers: BravoMarker[] = rows
    .filter(r => r.lat != null && r.lng != null)
    .map(r => ({
      id: r.id,
      lat: r.lat as number,
      lng: r.lng as number,
      label: `${r.short_code ?? r.id} · ${r.status}`,
      type: r.status === 'SOS' ? 'sos' as const : 'live' as const,
    }));

  const sosCount = all.filter(r => r.status === 'SOS').length;
  const activeCount = all.length;

  return (
    <Shell>
      <div className="page-head" style={{marginBottom:12}}>
        <div>
          <div className="page-crumbs">Ops · Live</div>
          <h2>Live Operations</h2>
        </div>
        <div className="page-head-right">
          <span className="pill pill-live">● {activeCount} ACTIVE</span>
          {sosCount > 0 && <span className="pill pill-err">⚠ {sosCount} SOS</span>}
          <Link href="/live/wall" className="btn btn-ghost">⊞ WALL VIEW</Link>
        </div>
      </div>

      {/* SOS banner — only when any SOS is active */}
      {sosCount > 0 && (
        <div style={{marginBottom:12, padding:'10px 14px', background:'rgba(213,0,0,0.15)', border:'1px solid var(--err)', borderRadius:8, display:'flex', alignItems:'center', gap:12, flexShrink:0}}>
          <span className="pill" style={{background:'var(--err)', borderColor:'var(--err)', color:'#fff', animation:'pill-pulse 1.6s infinite'}}>SOS</span>
          <span style={{fontFamily:'Manrope', fontWeight:700, fontSize:12, color:'var(--tx-1)'}}>EMERGENCY ALERT</span>
          <span style={{fontFamily:'JetBrains Mono', fontSize:11, color:'var(--tx-2)'}}>
            {sosCount} mission(s) in SOS state — acknowledge from detail view
          </span>
          {rows.find(r => r.status === 'SOS') && (
            <Link href={`/live/${rows.find(r => r.status === 'SOS')!.id}`} className="btn btn-sm" style={{marginLeft:'auto', background:'var(--err)', color:'#fff', border:'none'}}>
              RESPOND →
            </Link>
          )}
        </div>
      )}

      <div style={{display:'grid', gridTemplateColumns:'1fr 340px', gap:12, flex:1, minHeight:0}}>
        {/* Map (Mapbox) */}
        <div className="card" style={{overflow:'hidden', position:'relative'}}>
          <BravoMap
            markers={markers}
            center={[55.17, 25.12]}
            zoom={10}
            style={{position:'absolute', inset:0}}
          />
        </div>

        {/* Missions panel */}
        <div className="card" style={{display:'flex', flexDirection:'column', overflow:'hidden'}}>
          <div className="card-header">
            <div className="card-header-title"><span className="bar"/>{tab === 'active' ? 'Active Missions' : 'Completed Missions'}</div>
            <div className="card-header-act">
              {q ? `${rows.length} / ${all.length}` : `${all.length} ${tab === 'active' ? 'LIVE' : 'CLOSED'}`}
            </div>
          </div>
          {/* Active / Completed tab switch */}
          <div style={{display:'flex', borderBottom:'1px solid var(--bd-2)'}}>
            {(['active','completed'] as const).map(k => (
              <button
                key={k}
                onClick={() => { setTab(k); setQuery(''); }}
                style={{
                  flex:1, padding:'8px 0',
                  background: tab === k ? 'var(--surf-3)' : 'transparent',
                  color:      tab === k ? 'var(--tx-1)'  : 'var(--tx-3)',
                  border:'none',
                  borderBottom: tab === k ? `2px solid ${k === 'active' ? 'var(--act)' : 'var(--ok)'}` : '2px solid transparent',
                  fontFamily:'JetBrains Mono', fontSize:10.5, fontWeight:700, letterSpacing:1.2,
                  textTransform:'uppercase', cursor:'pointer',
                }}>
                {k === 'active' ? 'Active' : 'Completed'}
              </button>
            ))}
          </div>
          <div style={{padding:'10px 12px', borderBottom:'1px solid var(--bd-2)'}}>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search by client, email, short code, route…"
              style={{
                width:'100%', height:32, borderRadius:6,
                background:'var(--surf-3)', border:'1px solid var(--bd-2)',
                padding:'0 10px', color:'var(--tx-1)',
                fontFamily:'JetBrains Mono', fontSize:11, outline:'none',
              }}
            />
          </div>
          <div style={{flex:1, overflowY:'auto'}}>
            {isLoading && (
              <div style={{padding:24,color:'var(--tx-3)',fontSize:11.5,textAlign:'center'}}>Loading…</div>
            )}
            {error && (
              <div style={{padding:24,color:'var(--err)',fontSize:11.5,textAlign:'center'}}>Failed to load missions.</div>
            )}
            {!isLoading && !error && rows.length === 0 && (
              <div style={{padding:24,color:'var(--tx-3)',fontSize:11.5,textAlign:'center'}}>
                {q ? `No missions match "${query}".` : 'No active missions.'}
              </div>
            )}
            {rows.map(m => (
              <Link key={m.id} href={`/live/${m.id}`} style={{textDecoration:'none', display:'block'}}>
                <div style={{padding:'12px 14px', borderBottom:'1px solid var(--bd-2)', cursor:'pointer'}}>
                  <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                    <span style={{fontFamily:'JetBrains Mono', fontSize:10.5, color:'var(--acc)', fontWeight:700}}>
                      {m.short_code} · {m.region}
                    </span>
                    <span className={`pill ${
                      m.status === 'SOS'       ? 'pill-err pill-live' :
                      m.status === 'COMPLETED' ? 'pill-ok' :
                      m.status === 'ABORTED'   ? 'pill-err' :
                      'pill-act'
                    }`}>● {m.status}</span>
                  </div>
                  <div style={{fontFamily:'Manrope', fontSize:13, color:'var(--tx-1)', fontWeight:700, marginTop:6}}>
                    {m.client_name}
                  </div>
                  {/* Audit PAGE-15 — client email dropped from the list row (was
                      plaintext + unaudited, and can't host a reveal button inside
                      the row-wide <Link>). It stays masked + audited on the
                      mission detail page. */}
                  <div style={{fontFamily:'JetBrains Mono', fontSize:10.5, color:'var(--tx-2)', marginTop:5, lineHeight:1.4}}>
                    {m.route}
                  </div>
                  <div style={{fontFamily:'JetBrains Mono', fontSize:9.5, color:'var(--tx-3)', display:'flex', gap:12, marginTop:6}}>
                    <span><b style={{color:'var(--tx-2)'}}>{m.vehicle}</b></span>
                    <span>ETA <b style={{color: m.status === 'SOS' ? 'var(--err)' : 'var(--glow)'}}>{m.eta}</b></span>
                  </div>
                </div>
              </Link>
            ))}
            {tab === 'completed' && !isLoading && !error && all.length >= closedLimit && closedLimit < 500 && (
              <div style={{padding:'10px 0', textAlign:'center'}}>
                <button className="btn btn-sm btn-ghost" onClick={() => setClosedLimit(l => Math.min(l + 100, 500))}>
                  LOAD MORE ({all.length} loaded)
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </Shell>
  );
}
