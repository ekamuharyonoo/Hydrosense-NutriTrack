import { requireUser } from '@/lib/server/auth';
import AdminView from '@/components/AdminView';

export const metadata = { title: 'Admin · HydroSense' };
export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const user = await requireUser({ admin: true });
  return <AdminView user={user} />;
}
