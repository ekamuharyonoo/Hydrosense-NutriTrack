import {
  requireApiUser, readJson, bad, findUserById, updateUser, setPassword, deleteUserSessions,
  countActiveAdmins, randomPassword, publicUser,
} from '@/lib/server/auth';
import { getDb, logActivity } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Daftar pengguna (admin). */
export async function GET(req) {
  const { error } = await requireApiUser(req, { admin: true });
  if (error) return error;
  const d = await getDb();
  const rows = d.prepare(`
    SELECT u.*, (SELECT COUNT(*) FROM devices WHERE owner_user_id = u.id AND type = 'master') AS masters
    FROM users u ORDER BY CASE u.status WHEN 'pending' THEN 0 ELSE 1 END, u.created_at DESC
  `).all();
  return Response.json({
    users: rows.map(r => ({ ...publicUser(r), createdAt: r.created_at, approvedAt: r.approved_at, masters: r.masters })),
  });
}

/** Aksi admin terhadap satu pengguna: { id, action, role? } */
export async function POST(req) {
  const { error, row: admin } = await requireApiUser(req, { admin: true, write: true });
  if (error) return error;
  const body = await readJson(req);
  const target = await findUserById(Number(body?.id));
  if (!target) return bad('Pengguna tidak ditemukan.', 404);
  const action = String(body?.action || '');
  const self = target.id === admin.id;
  const lastAdmin = target.role === 'admin' && target.status === 'active' && (await countActiveAdmins(target.id)) === 0;
  let result = {};

  switch (action) {
    case 'approve':
      if (target.status !== 'pending' && target.status !== 'rejected') return bad('Hanya akun menunggu/ditolak yang bisa disetujui.');
      await updateUser(target.id, { status: 'active', approved_by: admin.id, approved_at: Date.now() });
      break;
    case 'reject':
      if (target.status !== 'pending') return bad('Hanya akun yang menunggu persetujuan yang bisa ditolak.');
      await updateUser(target.id, { status: 'rejected' });
      break;
    case 'disable':
      if (self) return bad('Tidak bisa menonaktifkan akun sendiri.');
      if (lastAdmin) return bad('Harus selalu ada minimal satu admin aktif.');
      await updateUser(target.id, { status: 'disabled' });
      await deleteUserSessions(target.id);
      break;
    case 'enable':
      if (target.status !== 'disabled') return bad('Akun ini tidak sedang nonaktif.');
      await updateUser(target.id, { status: 'active' });
      break;
    case 'role': {
      const role = body?.role === 'admin' ? 'admin' : 'petani';
      if (role === target.role) return bad('Peran tidak berubah.');
      if (role === 'petani' && lastAdmin) return bad('Harus selalu ada minimal satu admin aktif.');
      if (self) return bad('Tidak bisa mengubah peran akun sendiri.');
      await updateUser(target.id, { role });
      await deleteUserSessions(target.id); // paksa login ulang dengan hak baru
      result = { role };
      break;
    }
    case 'reset_password': {
      if (self) return bad('Ganti password sendiri lewat halaman Akun.');
      const temp = randomPassword(target.role === 'admin' ? 14 : 10);
      await setPassword(target.id, temp, { mustChange: true });
      await deleteUserSessions(target.id);
      result = { tempPassword: temp }; // ditampilkan sekali ke admin, tidak disimpan
      break;
    }
    default:
      return bad('Aksi tidak dikenal.');
  }

  await logActivity(admin.id, `admin_${action}`, target.username, action === 'role' ? result.role : null);
  return Response.json({ ok: true, ...result });
}
