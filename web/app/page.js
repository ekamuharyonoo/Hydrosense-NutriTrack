import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/server/auth';
import { listMastersFor } from '@/lib/server/devices';
import DeviceList from '@/components/DeviceList';

export const dynamic = 'force-dynamic';

/** Beranda: 1 master → langsung dashboard-nya; lebih dari 1 → daftar; 0 → ajakan klaim perangkat. */
export default async function Page() {
  const user = await requireUser();
  const devices = await listMastersFor(user);
  if (devices.length === 1 && user.role !== 'admin') redirect(`/perangkat/${devices[0].id}`);
  return <DeviceList user={user} initial={devices} />;
}
