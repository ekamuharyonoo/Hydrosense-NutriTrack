import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/server/auth';
import { googleEnabled } from '@/lib/server/google';
import AuthForm from '@/components/AuthForm';

export const metadata = { title: 'Daftar · HydroSense' };

export default async function RegisterPage() {
  if (await getCurrentUser()) redirect('/');
  return <AuthForm mode="register" google={googleEnabled()} />;
}
