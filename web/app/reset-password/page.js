import { peekToken } from '@/lib/server/auth';
import { ResetForm } from '@/components/PasswordPages';

export const metadata = { title: 'Password baru · HydroSense' };
export const dynamic = 'force-dynamic';

export default async function ResetPage({ searchParams }) {
  const token = String((await searchParams)?.token || '');
  const valid = !!(await peekToken('reset_password', token));
  return <ResetForm token={token} valid={valid} />;
}
