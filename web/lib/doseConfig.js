// Batas harus sama dengan CFG_* di Master/ESP-Master/config.h — master memvalidasi ulang sendiri.
export const DOSE_LIMITS = {
  tdsMin: 100, tdsMax: 3000, tdsGap: 50,
  doseMinMs: 500, doseMaxMs: 15000,
  cooldownMin: 1, cooldownMax: 60,
};

export const DEFAULT_DOSE = { tdsLo: 1000, tdsHi: 1400, doseMs: 3000, cooldownMin: 5 };

/** Nilai aktif di master (dari telemetry.cfg); firmware lama belum mengirimnya → default. */
export function doseOf(tel) {
  const c = tel?.cfg;
  return c && Number.isFinite(c.tdsLo) && Number.isFinite(c.tdsHi) ? { ...DEFAULT_DOSE, ...c } : DEFAULT_DOSE;
}

export function validateDose(v) {
  const L = DOSE_LIMITS;
  const tdsLo = Math.round(Number(v?.tdsLo));
  const tdsHi = Math.round(Number(v?.tdsHi));
  const doseMs = Math.round(Number(v?.doseMs));
  const cooldownMin = Math.round(Number(v?.cooldownMin));
  if (!(tdsLo >= L.tdsMin && tdsHi <= L.tdsMax)) return { error: `TDS harus di antara ${L.tdsMin}–${L.tdsMax} ppm.` };
  if (!(tdsHi - tdsLo >= L.tdsGap)) return { error: `TDS atas minimal ${L.tdsGap} ppm di atas TDS bawah.` };
  if (!(doseMs >= L.doseMinMs && doseMs <= L.doseMaxMs)) return { error: `Lama pompa ${L.doseMinMs / 1000}–${L.doseMaxMs / 1000} detik.` };
  if (!(cooldownMin >= L.cooldownMin && cooldownMin <= L.cooldownMax)) return { error: `Jeda antar dosis ${L.cooldownMin}–${L.cooldownMax} menit.` };
  return { value: { tdsLo, tdsHi, doseMs, cooldownMin } };
}
