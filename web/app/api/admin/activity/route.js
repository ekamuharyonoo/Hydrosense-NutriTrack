import { requireApiUser } from '@/lib/server/auth';
import { listActivity } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Log aktivitas terbaru (admin). */
export async function GET(req) {
  const { error } = await requireApiUser(req, { admin: true });
  if (error) return error;
  return Response.json({ activity: await listActivity(300) });
}
