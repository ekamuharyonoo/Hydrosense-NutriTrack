import { Fragment } from 'react';
import { LIM, bucket, minsAgo } from '@/lib/data';
import NotifItem from './NotifItem';

const RANGES = [
  ['hari', 'Hari ini'],
  ['minggu', 'Minggu ini'],
  ['bulan', 'Bulan ini'],
];

export default function NotifView({ notifs, now, range, onRange, note }) {
  const list = notifs.filter(n => minsAgo(n.ts, now) < LIM[range]);
  let last = '';

  return (
    <div className="view active" id="view-notif"><section className="section"><div className="container">
      <div className="section-head">
        <h2 className="section-title">Semua Notifikasi</h2>
        <span className="section-hint">{list.length} notifikasi</span>
      </div>
      <div className="mode-note">{note}</div>

      <div className="chips">
        {RANGES.map(([k, l]) => (
          <button key={k} className={`chip${range === k ? ' active' : ''}`} type="button" onClick={() => onRange(k)}>{l}</button>
        ))}
      </div>

      <div className="notif-list">
        {list.length === 0 && <div className="empty">Belum ada notifikasi pada periode ini.</div>}
        {list.map(n => {
          const b = bucket(minsAgo(n.ts, now));
          const head = b !== last ? b : null;
          last = b;
          return (
            <Fragment key={n.id}>
              {head && <div className="group-title">{head}</div>}
              <NotifItem n={n} now={now} />
            </Fragment>
          );
        })}
      </div>
    </div></section></div>
  );
}
