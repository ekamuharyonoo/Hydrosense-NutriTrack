import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/server/auth';
import { getDevice, canView, canControl, listMastersFor } from '@/lib/server/devices';
import Dashboard from '@/components/Dashboard';

export const dynamic = 'force-dynamic';

/** Dashboard satu master (= satu tandon). Pemilik: penuh. Admin: hanya lihat. */
export default async function DevicePage({ params }) {
  const user = await requireUser();
  const dev = await getDevice((await params).id);
  if (!canView(user, dev) || dev.type !== 'master') notFound();
  const mine = await listMastersFor(user);
  return (
    <Dashboard
      user={user}
      deviceId={dev.id}
      deviceName={dev.name || dev.id}
      canControl={canControl(user, dev)}
      multi={mine.length > 1 || user.role === 'admin'}
    />
  );
}
