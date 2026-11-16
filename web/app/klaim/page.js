import { redirect } from 'next/navigation';
import { getCurrentUserRow, requireUser } from '@/lib/server/auth';
import { listMastersFor, normalizeId } from '@/lib/server/devices';
import ClaimView from '@/components/ClaimView';

export const metadata = { title: 'Tambah perangkat · HydroSense' };
export const dynamic = 'force-dynamic';

/** /klaim?id=HSM-…&kode=XXXX-XXXX (dari QR label) — belum login → login dulu lalu kembali. */
export default async function ClaimPage({ searchParams }) {
  const sp = await searchParams;
  if (!(await getCurrentUserRow())) {
    const back = new URLSearchParams(Object.entries(sp || {}).map(([k, v]) => [k, String(v)])).toString();
    redirect(`/login?lanjut=${encodeURIComponent(`/klaim${back ? `?${back}` : ''}`)}`);
  }
  const user = await requireUser();
  const masters = (await listMastersFor(user)).map(m => ({ id: m.id, name: m.name }));
  return (
    <ClaimView
      user={user}
      masters={masters}
      initial={{ id: normalizeId(sp?.id), code: String(sp?.kode || ''), master: normalizeId(sp?.master) }}
    />
  );
}
