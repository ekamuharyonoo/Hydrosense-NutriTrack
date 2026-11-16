import { appUrl, getCurrentUserRow, cookieHeader, isHttps } from '@/lib/server/auth';
import { googleEnabled, buildAuthRequest } from '@/lib/server/google';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Mulai login Google. ?mode=link (dari halaman Akun) untuk menautkan ke akun yang sedang login. */
export async function GET(req) {
  const base = await appUrl(req);
  if (!googleEnabled()) return Response.redirect(`${base}/login?pesan=google-nonaktif`, 303);
  const mode = new URL(req.url).searchParams.get('mode') === 'link' ? 'link' : 'login';
  if (mode === 'link' && !(await getCurrentUserRow())) return Response.redirect(`${base}/login`, 303);

  const { url, state, verifier } = buildAuthRequest(base);
  const res = new Response(null, { status: 303, headers: { Location: url } });
  res.headers.append('Set-Cookie', cookieHeader({
    name: 'hs_oauth', value: Buffer.from(JSON.stringify({ state, verifier, mode })).toString('base64url'),
    maxAge: 600, secure: isHttps(req),
  }));
  return res;
}
