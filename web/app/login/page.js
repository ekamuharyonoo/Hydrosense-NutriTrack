import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/server/auth';
import { googleEnabled } from '@/lib/server/google';
import AuthForm from '@/components/AuthForm';

export const metadata = { title: 'Masuk · HydroSense' };

export default async function LoginPage({ searchParams }) {
  const sp = await searchParams;
  const next = String(sp?.lanjut || '');
  if (await getCurrentUser()) redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
  return <AuthForm mode="login" google={googleEnabled()} pesan={String(sp?.pesan || '')} email={String(sp?.email || '')} next={String(sp?.lanjut || '')} />;
}
