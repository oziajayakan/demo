// server/index.js
// Entry point utama aplikasi lokal Express + SQLite
const app = require('./app');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log('====================================================');
  console.log(`🚀 SISTEM ANALISIS & VALIDASI KULIT WAJAH BERJALAN`);
  console.log(`🔗 Scan & Mode Penelitian : http://localhost:${PORT}/`);
  console.log(`👨‍⚕️ Penilaian Blind Review Dokter : http://localhost:${PORT}/dokter`);
  console.log(`📊 Hasil Validasi & Akurasi      : http://localhost:${PORT}/validasi`);
  console.log('====================================================');
});
