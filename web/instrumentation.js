// Dipanggil Next.js sekali saat server start → mulai merekam MQTT ke SQLite.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startRecorder } = await import('./lib/server/recorder');
  await startRecorder();
}
