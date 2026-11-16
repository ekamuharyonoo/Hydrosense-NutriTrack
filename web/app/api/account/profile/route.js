import { requireApiUser, readJson, bad, updateUser } from '@/lib/server/auth';

export const runtime = 'nodejs';

/** Ganti nama tampilan. */
export async function POST(req) {
  const { error, row } = await requireApiUser(req, { write: true });
  if (error) return error;
  const name = String((await readJson(req))?.name || '').trim();
  if (name.length < 2 || name.length > 60) return bad('Nama harus 2–60 karakter.');
  await updateUser(row.id, { name });
  return Response.json({ ok: true });
}
