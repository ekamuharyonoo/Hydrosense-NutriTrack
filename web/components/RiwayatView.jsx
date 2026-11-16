import { COL, LBL, HKEYS, WK, padTo, sum, mo, runningDays } from '@/lib/data';
import Chart from './Chart';

function HarvestRow({ label, days, max, running }) {
  return (
    <div className="hv">
      <div className="hv-top">
        <span>{label}</span>
        <b>{mo(days)} <small>· {days} hari</small></b>
      </div>
      <div className="hv-track">
        <div className={`hv-bar${running ? ' run' : ''}`} style={{ width: `${(days / max) * 100}%` }} />
      </div>
    </div>
  );
}

export default function RiwayatView({ history, mode, now, note, onHarvest }) {
  if (!history) {
    return (
      <div className="view active" id="view-riwayat"><section className="section"><div className="container">
        <div className="section-head"><h2 className="section-title">Riwayat Satu Periode Panen</h2></div>
        <div className="glass card empty">Menunggu data riwayat dari ESP32…</div>
      </div></section></div>
    );
  }

  const harvests = Array.isArray(history.harvests) ? history.harvests : [];
  const get = (src, k) => (Array.isArray(history[src]?.[k]) ? history[src][k] : []);
  const cur = (history.week || 0) + 1;            // minggu berjalan (mulai 1)
  const weeks = Math.max(WK, cur);
  const run = runningDays(history, now);
  const max = Math.max(...harvests, run, 100);

  const ta = HKEYS.reduce((s, k) => s + sum(get('auto', k)), 0);
  const tm = HKEYS.reduce((s, k) => s + sum(get('manual', k)), 0);
  const ymax = Math.max(8, Math.ceil(Math.max(0, ...HKEYS.flatMap(k => get(mode, k))) / 4) * 4);
  const avg = harvests.length ? Math.round(sum(harvests) / harvests.length) : 0;

  return (
    <div className="view active" id="view-riwayat"><section className="section"><div className="container">
      <div className="section-head">
        <h2 className="section-title">Riwayat Satu Periode Panen</h2>
        <span className="section-hint">Periode ke-{harvests.length + 1} · minggu {cur}</span>
      </div>
      <div className="mode-note">{note}</div>

      <div className="stats">
        {HKEYS.map(k => (
          <div key={k} className="glass stat"><b>{sum(get(mode, k))}×</b><span>{LBL[k]}</span></div>
        ))}
      </div>

      <div className="glass card chart-card">
        <h3 className="chart-title">Frekuensi penambahan per minggu</h3>
        <div className="legend">
          {HKEYS.map(k => <span key={k}><i style={{ background: COL[k] }} />{LBL[k]}</span>)}
        </div>
        <Chart
          label="Grafik frekuensi penambahan"
          ymax={ymax}
          weeks={weeks}
          series={HKEYS.map(k => ({ c: COL[k], data: padTo(get(mode, k).slice(0, cur), weeks) }))}
        />
      </div>

      <div className="glass card chart-card">
        <div className="head-row">
          <h3 className="chart-title">Periode Panen</h3>
          {onHarvest && <button className="btn-sm" type="button" onClick={onHarvest}>Catat panen</button>}
        </div>
        <p className="mode-note">
          Lama tiap periode dari tanam sampai panen. Silakan lakukan pencatatan jika masa panen telah tiba dan dilakukan.
        </p>
        <div>
          {harvests.map((days, i) => (
            <HarvestRow key={i} label={`Panen ke-${i + 1}`} days={days} max={max} />
          ))}
          <HarvestRow label={`Periode ke-${harvests.length + 1} (berjalan)`} days={run} max={max} running />
        </div>
      </div>

      <div className="glass card insight">
        <b>Evaluasi:</b>{' '}
        {harvests.length
          ? <>rata-rata {harvests.length} panen sebelumnya <b>{mo(avg)}</b> ({avg} hari), tercepat <b>{mo(Math.min(...harvests))}</b>. </>
          : <>belum ada panen yang dicatat. </>}
        Periode berjalan sudah {run} hari. Selama {cur} minggu ini sistem melakukan rata-rata{' '}
        <b>{(ta / cur).toFixed(1)}</b> penambahan per minggu, petani <b>{(tm / cur).toFixed(1)}</b>.
      </div>
    </div></section></div>
  );
}
