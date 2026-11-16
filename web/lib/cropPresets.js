// Template target TDS per tanaman. Template hanya mengisi TDS bawah/atas; lama pompa & jeda
// bergantung pada ukuran tandon & pompa, jadi tidak diubah.
//
// Sumber EC (mS/cm): tabel pH/cF/PPM Atlantis Hydroponics (cF = EC × 10), kecuali disebut lain.
// Tabel aslinya memakai skala ppm 700. Sensor TDS node HydroSense memakai skala 500
// (ppm = EC µS/cm × 0,5), jadi semua nilai di sini = EC × 500.

const ATLANTIS_VEG = 'https://atlantishydroponics.com/pages/ph-ppm-cf-values-of-various-vegetables';
const ATLANTIS_FRUIT = 'https://atlantishydroponics.com/pages/plant-ph-ppm-cf-guide-fruits';
const POLINELA_MELON = 'https://jurnal.polinela.ac.id/index.php/PROSIDING/article/view/1168';

const ppm = ec => Math.round((ec * 500) / 10) * 10;
const crop = (id, name, group, ecLo, ecHi, source, note) =>
  ({ id, name, group, ec: [ecLo, ecHi], tdsLo: ppm(ecLo), tdsHi: ppm(ecHi), source, note });

export const CROP_PRESETS = [
  crop('melon', 'Melon', 'Buah', 2.0, 2.5, ATLANTIS_FRUIT),
  crop('melon-buah', 'Melon (fase pembuahan)', 'Buah', 2.5, 3.0, POLINELA_MELON, 'Penelitian melon hidroponik: EC 3 mS/cm paling efisien.'),
  crop('semangka', 'Semangka', 'Buah', 1.5, 2.4, ATLANTIS_FRUIT),
  crop('stroberi', 'Stroberi', 'Buah', 1.8, 2.2, ATLANTIS_FRUIT),
  crop('tomat', 'Tomat', 'Buah', 2.0, 5.0, ATLANTIS_VEG, 'Rentang lebar: mulai dari bawah, naikkan saat berbuah.'),
  crop('mentimun', 'Mentimun', 'Buah', 1.7, 2.5, ATLANTIS_VEG),
  crop('cabai', 'Cabai / paprika', 'Buah', 1.8, 2.2, ATLANTIS_VEG),
  crop('terong', 'Terong', 'Buah', 2.5, 3.5, ATLANTIS_VEG),
  crop('selada', 'Selada', 'Sayur daun', 0.8, 1.2, ATLANTIS_VEG),
  crop('pakcoy', 'Pakcoy', 'Sayur daun', 1.5, 2.0, ATLANTIS_VEG),
  crop('bayam', 'Bayam', 'Sayur daun', 1.8, 2.3, ATLANTIS_VEG),
  crop('seledri', 'Seledri', 'Sayur daun', 1.8, 2.4, ATLANTIS_VEG),
  crop('kubis', 'Kubis / kol', 'Sayur daun', 2.5, 3.0, ATLANTIS_VEG),
];

export const presetFor = (tdsLo, tdsHi) =>
  CROP_PRESETS.find(p => p.tdsLo === Number(tdsLo) && p.tdsHi === Number(tdsHi)) || null;
