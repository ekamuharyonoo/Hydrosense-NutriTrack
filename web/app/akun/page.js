import { requireUser } from '@/lib/server/auth';
import { googleEnabled } from '@/lib/server/google';
import { mailEnabled } from '@/lib/server/mail';
import AccountView from '@/components/AccountView';

export const metadata = { title: 'Akun · HydroSense' };
export const dynamic = 'force-dynamic';

export default async function AccountPage({ searchParams }) {
  const user = await requireUser({ allowMustChange: true });
  const sp = await searchParams;
  return (
    <AccountView
      user={user}
      wajib={sp?.wajib === '1' || user.mustChangePassword}
      pesan={String(sp?.pesan || '')}
      google={googleEnabled()}
      mail={mailEnabled()}
    />
  );
}
