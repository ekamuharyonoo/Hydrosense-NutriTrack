import { mailEnabled } from '@/lib/server/mail';
import { ForgotForm } from '@/components/PasswordPages';

export const metadata = { title: 'Lupa password · HydroSense' };
export const dynamic = 'force-dynamic';

export default function ForgotPage() {
  return <ForgotForm mail={mailEnabled()} />;
}
