import { WK } from '@/lib/data';

const W = 320, H = 170, L = 28, R = 10, T = 10, B = 24;

/** Grafik garis sederhana berbasis SVG (tanpa library). */
export default function Chart({ series, ymax, weeks = WK, id = 'chart1', label }) {
  const x = i => L + (i * (W - L - R)) / Math.max(1, weeks - 1);
  const y = v => T + (H - T - B) * (1 - v / ymax);
  const ticks = [0, 1, 2, 3, 4].map(k => (ymax * k) / 4);
  const step = weeks > 16 ? 2 : 1; // label sumbu-x dijarangkan bila minggu banyak

  return (
    <svg viewBox={`0 0 ${W} ${H}`} id={id} role="img" aria-label={label}>
      {ticks.map(v => (
        <g key={`y${v}`}>
          <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="gl" />
          <text x={L - 5} y={y(v) + 3} className="ax" textAnchor="end">{+v.toFixed(1)}</text>
        </g>
      ))}
      {Array.from({ length: weeks }, (_, i) => (i % step === 0 ? (
        <text key={`x${i}`} x={x(i)} y={H - 8} className="ax" textAnchor="middle">{i + 1}</text>
      ) : null))}
      {series.map((s, si) => {
        const pts = s.data.map((v, i) => (v == null ? null : [x(i), y(v)])).filter(Boolean);
        return (
          <g key={si}>
            <polyline
              points={pts.map(p => p.join(',')).join(' ')}
              fill="none"
              stroke={s.c}
              strokeWidth="2.4"
              strokeLinejoin="round"
              strokeDasharray={s.dash ? '5 4' : undefined}
            />
            {!s.dash && pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r="2.6" fill={s.c} />)}
          </g>
        );
      })}
    </svg>
  );
}
