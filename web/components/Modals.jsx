import { useState } from 'react';
import { BoltIcon } from './Icons';

export function BackupModal({ onCancel, onConfirm }) {
  return (
    <div className="modal" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="glass modal-card" role="dialog" aria-modal="true" aria-labelledby="m-title">
        <div className="modal-icon t-crit"><BoltIcon /></div>
        <h2 className="modal-title" id="m-title">Listrik PLN padam</h2>
        <p className="modal-text">
          Pompa utama belum pindah ke baterai secara otomatis. Aktifkan daya cadangan sekarang agar sirkulasi air tetap berjalan?
        </p>
        <div className="modal-actions">
          <button className="btn btn-ghost" type="button" onClick={onCancel}>Nanti</button>
          <button className="btn btn-gold" type="button" onClick={onConfirm}>Aktifkan</button>
        </div>
      </div>
    </div>
  );
}

export function HarvestModal({ defaultDays, onCancel, onSave }) {
  const [days, setDays] = useState(String(defaultDays));

  return (
    <div className="modal" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="glass modal-card" role="dialog" aria-modal="true" aria-labelledby="h-title">
        <h2 className="modal-title" id="h-title">Catat panen</h2>
        <p className="modal-text">
          Melon sudah masuk masa panen? Periode ini akan disimpan sebagai riwayat, lalu periode baru dimulai.
        </p>
        <label className="field">
          Lama periode (hari)
          <input
            type="number" min="1" max="200" inputMode="numeric"
            value={days} onChange={e => setDays(e.target.value)} autoFocus
          />
        </label>
        <div className="modal-actions">
          <button className="btn btn-ghost" type="button" onClick={onCancel}>Batal</button>
          <button className="btn btn-gold" type="button" onClick={() => onSave(Math.round(+days))}>Simpan panen</button>
        </div>
      </div>
    </div>
  );
}
