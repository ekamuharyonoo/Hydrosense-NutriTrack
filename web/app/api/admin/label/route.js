import { requireApiUser, readJson, bad, appUrl } from '@/lib/server/auth';
import { labelSvg } from '@/lib/server/label';
import { ID_RE, normalizeId, normalizeCode } from '@/lib/server/devices';

export const runtime = 'nodejs';

/** Buat label QR (SVG) dari ID + kode yang baru saja ditampilkan ke admin. Kode tidak disimpan. */
export async function POST(req) {
  const { error } = await requireApiUser(req, { admin: true, write: true });
  if (error) return error;
  const body = await readJson(req);
  const id = normalizeId(body?.id);
  const raw = normalizeCode(body?.code);
  if (!ID_RE.test(id) || raw.length !== 8) return bad('ID atau kode tidak valid.');
  const svg = await labelSvg({ base: await appUrl(req), id, code: `${raw.slice(0, 4)}-${raw.slice(4)}` });
  return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' } });
}
