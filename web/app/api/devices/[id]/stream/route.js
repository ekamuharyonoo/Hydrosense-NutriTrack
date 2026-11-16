import { requireApiUser } from '@/lib/server/auth';
import { getDevice, canView, canControl, topicOf, nodesOf } from '@/lib/server/devices';
import { getSnapshot, logActivity } from '@/lib/server/db';
import { bus, recorderState, publishCommand } from '@/lib/server/recorder';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Data live satu master lewat Server-Sent Events (menggantikan koneksi MQTT langsung dari browser).
 *   event: snapshot  → data terakhir dari SQLite (status, telemetry, history, events, lastValues)
 *   event: msg       → pesan MQTT baru { kind, data, receivedAt }
 *   event: server    → status koneksi server ke broker { connected }
 */
export async function GET(req, { params }) {
  const { error, user } = await requireApiUser(req);
  if (error) return error;
  const dev = await getDevice((await params).id);
  if (!canView(user, dev) || dev.type !== 'master') return Response.json({ error: 'Perangkat tidak ditemukan.' }, { status: 404 });
  if (user.role === 'admin' && dev.owner_user_id !== user.id) await logActivity(user.id, 'admin_lihat_perangkat', dev.id);

  const topic = topicOf(dev.id);
  const snapshot = await getSnapshot(topic);
  const nodes = (await nodesOf(dev.id)).map(n => ({ id: n.id, name: n.name }));
  const enc = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const send = (event, data) => {
        try { controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch {}
      };
      send('snapshot', {
        ...snapshot,
        device: { id: dev.id, name: dev.name || dev.id, nodes },
        canControl: canControl(user, dev),
        server: { connected: recorderState.connected },
      });
      const onMsg = m => send('msg', m);
      bus.on(topic, onMsg);
      let lastConn = recorderState.connected;
      // Dashboard dibuka → Unit Kontrol minta Unit Monitor kirim tiap 5 dtk (LIVE_HOLD_MS di firmware: 90 dtk)
      const live = () => publishCommand(dev.id, { cmd: 'live' });
      live();
      const liveTick = setInterval(live, 60000);
      const tick = setInterval(() => {
        if (recorderState.connected !== lastConn) { lastConn = recorderState.connected; send('server', { connected: lastConn }); }
        try { controller.enqueue(enc.encode(': ping\n\n')); } catch {}
      }, 20000);
      cleanup = () => { bus.off(topic, onMsg); clearInterval(tick); clearInterval(liveTick); };
      req.signal.addEventListener('abort', () => { cleanup(); try { controller.close(); } catch {} });
    },
    cancel() { cleanup(); },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // matikan buffering di reverse proxy (nginx)
    },
  });
}
