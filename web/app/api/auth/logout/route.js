import { cookies } from 'next/headers';
import { SESSION_COOKIE, deleteSession, sessionCookie, cookieHeader, sameOrigin } from '@/lib/server/auth';

export const runtime = 'nodejs';

export async function POST(req) {
  if (!sameOrigin(req)) return Response.json({ error: 'Permintaan ditolak.' }, { status: 403 });
  await deleteSession((await cookies()).get(SESSION_COOKIE)?.value);
  const res = Response.json({ ok: true });
  res.headers.append('Set-Cookie', cookieHeader(sessionCookie(req, '', 0)));
  return res;
}
