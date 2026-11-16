import crypto from 'node:crypto';
import { requireApiUser, readJson, bad, findUserByLogin } from '@/lib/server/auth';
import { getDb, logActivity } from '@/lib/server/db';
import { registerDevice, getDevice, releaseDevice, transferDevice, resetClaimCode, normalizeId } from '@/lib/server/devices';
import { publishCommand } from '@/lib/server/recorder';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Alat produksi (tools/provision) memakai header Authorization: Bearer <PROVISION_TOKEN>. */
function provisionAuth(req) {
  const expected = process.env.PROVISION_TOKEN || '';
  const got = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!expected || !got) return false;
  const a = Buffer.from(got), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function adminOrProvision(req, write) {
  if (provisionAuth(req)) return { actor: null, via: 'provision' };
  const { error, user } = await requireApiUser(req, { admin: true, write });
  return error ? { error } : { actor: user.id, via: 'admin' };
}

/** Daftar semua perangkat (admin). */
export async function GET(req) {
  const auth = await adminOrProvision(req, false);
  if (auth.error) return auth.error;
  const d = await getDb();
  const rows = d.prepare(`
    SELECT dv.id, dv.type, dv.name, dv.master_id, dv.batch, dv.fw_version, dv.created_at, dv.claimed_at, dv.last_seen,
           u.username AS owner, (SELECT payload FROM latest WHERE topic = ? || '/' || dv.id AND kind = 'status') AS status
    FROM devices dv LEFT JOIN users u ON u.id = dv.owner_user_id
    ORDER BY dv.created_at DESC
  `).all(process.env.RECORDER_TOPIC_ROOT || 'hydrosense');
  return Response.json({ devices: rows });
}

/**
 * POST { action: 'register', devices: [{ id, type?, code?, batch?, fw? }] }  → daftar (produksi / CSV)
 *      { action: 'release' | 'reset_code' | 'transfer', id, username? }
 * Kode klaim hanya dikembalikan sekali (saat dibuat / di-reset) dan tidak bisa dilihat lagi.
 */
export async function POST(req) {
  const auth = await adminOrProvision(req, true);
  if (auth.error) return auth.error;
  const body = await readJson(req);
  const action = String(body?.action || '');

  if (action === 'register') {
    const list = Array.isArray(body.devices) ? body.devices.slice(0, 1000) : [];
    if (!list.length) return bad('Daftar perangkat kosong.');
    const created = [], errors = [];
    for (const item of list) {
      try { created.push(await registerDevice(item)); }
      catch (e) { errors.push({ id: item?.id, error: e.message }); }
    }
    if (created.length) await logActivity(auth.actor, 'daftar_perangkat', `${created.length} unit`, { via: auth.via, ids: created.map(c => c.id) });
    return Response.json({ ok: true, created, errors });
  }

  if (auth.via !== 'admin') return bad('Token produksi hanya boleh mendaftarkan perangkat.', 403);
  const dev = await getDevice(body?.id);
  if (!dev) return bad('Perangkat tidak ditemukan.', 404);

  switch (action) {
    case 'release':
      if (dev.type === 'master') publishCommand(dev.id, { cmd: 'unpair' });
      await releaseDevice(dev.id);
      await logActivity(auth.actor, 'admin_lepas_perangkat', dev.id);
      return Response.json({ ok: true });
    case 'reset_code': {
      const code = await resetClaimCode(dev.id);
      await logActivity(auth.actor, 'admin_reset_kode', dev.id);
      return Response.json({ ok: true, claimCode: code });
    }
    case 'transfer': {
      const target = await findUserByLogin(String(body?.username || '').toLowerCase());
      if (!target || target.status !== 'active') return bad('Akun tujuan tidak ditemukan atau belum aktif.');
      await transferDevice(dev.id, target.id);
      await logActivity(auth.actor, 'admin_pindah_perangkat', normalizeId(dev.id), target.username);
      return Response.json({ ok: true });
    }
    default:
      return bad('Aksi tidak dikenal.');
  }
}
