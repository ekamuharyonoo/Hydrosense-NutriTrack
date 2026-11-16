/* Label QR perangkat (SVG, siap cetak): QR berisi URL klaim + teks ID & kode.
   Dipakai halaman admin (/api/admin/label) dan alat produksi (tools/provision). */

import QRCode from 'qrcode';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const claimUrl = (base, id, code) =>
  `${base.replace(/\/+$/, '')}/klaim?id=${encodeURIComponent(id)}&kode=${encodeURIComponent(code)}`;

/** Label 60×30 mm: QR di kiri, teks di kanan. */
export async function labelSvg({ base, id, code }) {
  const url = claimUrl(base, id, code);
  const qr = QRCode.create(url, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const cells = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.modules.get(x, y)) cells.push(`M${x} ${y}h1v1h-1z`);
  const type = id.startsWith('HSM-') ? 'ESP MASTER' : 'NODE SENSOR';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="60mm" height="30mm" viewBox="0 0 600 300">
  <rect width="600" height="300" fill="#fff"/>
  <svg x="12" y="12" width="276" height="276" viewBox="-2 -2 ${n + 4} ${n + 4}" shape-rendering="crispEdges">
    <path d="${cells.join('')}" fill="#000"/>
  </svg>
  <g font-family="Arial, Helvetica, sans-serif" fill="#000">
    <text x="305" y="58" font-size="30" font-weight="bold">HydroSense</text>
    <text x="305" y="92" font-size="20">${type}</text>
    <text x="305" y="150" font-size="17">ID</text>
    <text x="305" y="176" font-size="21" font-weight="bold">${esc(id)}</text>
    <text x="305" y="222" font-size="17">KODE KLAIM</text>
    <text x="305" y="256" font-size="32" font-weight="bold" letter-spacing="2">${esc(code)}</text>
  </g>
</svg>`;
}
