'use client';

import { Shell } from '@/components/Shell';
import { useDepartments } from '@/lib/api';

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export default function Departments() {
  const { data: channels, isLoading, error } = useDepartments();
  const rows = channels ?? [];

  return (
    <Shell>
      <div className="page-head">
        <div>
          <div className="page-crumbs">Ops · Department Channels</div>
          <h2>Department Channels</h2>
        </div>
        <div className="page-head-right">
          <span className="pill pill-info">● {rows.length} CHANNELS</span>
        </div>
      </div>

      {isLoading && (
        <div style={{padding:32,color:'var(--tx-3)'}}>Loading channels…</div>
      )}
      {error && (
        <div style={{padding:32,color:'var(--err)'}}>
          Failed to load channels · {String((error as Error).message)}
        </div>
      )}

      {!isLoading && !error && rows.length === 0 && (
        <div style={{padding:32,color:'var(--tx-3)'}}>
          No department channels yet. Channels are a Bravo Pro feature; create them per department.
        </div>
      )}

      {!isLoading && !error && rows.length > 0 && (
        <div style={{
          border:'1px solid var(--bd)', borderRadius:12, overflow:'hidden',
          background:'var(--sf-1)',
          // Why: .main-area is a flex column; a direct child with a
          // non-visible overflow has its flex min-height collapsed to 0,
          // so without this it shrinks to the leftover height and clips
          // the table instead of letting the page scroll. flexShrink:0
          // keeps it at full content height so .main-area scrolls.
          flexShrink:0,
        }}>
          <table style={{width:'100%', borderCollapse:'collapse', fontSize:13}}>
            <thead>
              <tr style={{textAlign:'left', color:'var(--tx-3)', background:'var(--sf-2)'}}>
                <th style={{padding:'12px 16px', fontWeight:600}}>Channel</th>
                <th style={{padding:'12px 16px', fontWeight:600}}>Department</th>
                <th style={{padding:'12px 16px', fontWeight:600, textAlign:'right'}}>Members</th>
                <th style={{padding:'12px 16px', fontWeight:600}}>Status</th>
                <th style={{padding:'12px 16px', fontWeight:600}}>Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(c => (
                <tr key={c.id} style={{borderTop:'1px solid var(--bd)'}}>
                  <td style={{padding:'12px 16px'}}>
                    <div style={{fontWeight:600, color:'var(--tx-1)'}}>{c.name}</div>
                    {c.description && (
                      <div style={{color:'var(--tx-3)', fontSize:12, marginTop:2}}>{c.description}</div>
                    )}
                  </td>
                  <td style={{padding:'12px 16px', color:'var(--tx-2)'}}>{c.department ?? '—'}</td>
                  <td style={{padding:'12px 16px', textAlign:'right', color:'var(--tx-2)'}}>{c.member_count}</td>
                  <td style={{padding:'12px 16px'}}>
                    <span className={`pill ${c.provisioned ? 'pill-ok' : 'pill-info'}`}>
                      {c.provisioned ? '● E2E active' : '○ Not active'}
                    </span>
                  </td>
                  <td style={{padding:'12px 16px', color:'var(--tx-3)'}}>{fmtDate(c.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}
