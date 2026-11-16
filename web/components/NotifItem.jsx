import { KCOL, ago, minsAgo } from '@/lib/data';

export default function NotifItem({ n, now }) {
  return (
    <div className="glass notif">
      <span className="notif-dot" style={{ background: `var(${KCOL[n.k]})` }} />
      <div>
        <div className="notif-text">{n.x}</div>
        <div className="notif-time">
          {ago(minsAgo(n.ts, now))}
          <span className="tag">{n.s === 'auto' ? 'Sistem' : 'Petani'}</span>
        </div>
      </div>
    </div>
  );
}
