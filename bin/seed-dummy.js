// bin/seed-dummy.js
// Skrip seed data DUMMY (ditandai jelas sebagai dummy untuk demonstrasi & pengujian alur)
// Menghasilkan 12 sampel dummy responden, prediksi AI, foto placeholder terisolasi,
// 2 akun dokter dummy (dr. Indah & dr. Budi), dan ulasan blind review dokter.

const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const { db, photosDir } = require('../server/db');

async function seed() {
  console.log('--- Memulai Seeding Data DUMMY Pengujian ---');

  // Bersihkan data dummy lama (hanya yang berawalan DUMMY-)
  db.prepare(`DELETE FROM reviews WHERE doctor_id IN (SELECT id FROM doctors WHERE nama LIKE '%[DUMMY]%')`).run();
  db.prepare(`DELETE FROM samples WHERE respondent_id IN (SELECT id FROM respondents WHERE kode LIKE 'DUMMY-%')`).run();
  db.prepare(`DELETE FROM respondents WHERE kode LIKE 'DUMMY-%'`).run();
  db.prepare(`DELETE FROM doctors WHERE nama LIKE '%[DUMMY]%'`).run();

  // 1. Buat 2 Akun Dokter Dummy
  const doc1Id = uuidv4();
  const doc2Id = uuidv4();
  const passHash1 = await bcrypt.hash('dokter123', 10);
  const passHash2 = await bcrypt.hash('dokter123', 10);

  const insDoc = db.prepare(`
    INSERT INTO doctors (id, nama, str_sip, instansi, password_hash)
    VALUES (?, ?, ?, ?, ?)
  `);

  insDoc.run(doc1Id, 'dr. Indah Permata, Sp.D.V.E [DUMMY]', 'STR-991203-DUMMY', 'RS Husada Mandiri', passHash1);
  insDoc.run(doc2Id, 'dr. Budi Santoso, Sp.KK [DUMMY]', 'STR-884192-DUMMY', 'Klinik Dermacare', passHash2);

  // Buat 1 file gambar placeholder dummy di data/photos jika belum ada
  const dummySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">
    <rect width="300" height="300" fill="#24102b"/>
    <circle cx="150" cy="120" r="60" fill="#c26bd0" opacity="0.6"/>
    <ellipse cx="150" cy="240" rx="90" ry="70" fill="#7a2a7e" opacity="0.6"/>
    <text x="150" y="280" font-family="sans-serif" font-size="14" fill="#ffffff" text-anchor="middle">SAMPEL DUMMY RISET</text>
  </svg>`;

  const dummyFileName = `dummy-sample-${Date.now()}.svg`;
  fs.writeFileSync(path.join(photosDir, dummyFileName), dummySvg, 'utf8');

  // 2. Daftar 10 Sampel Responden Dummy dengan skenario diagnosis bervariasi
  const types = ['berminyak', 'kering', 'normal', 'kombinasi'];
  const allConcerns = ['jerawat', 'flek_hitam', 'kemerahan', 'pori_besar', 'kerutan'];

  const insResp = db.prepare(`
    INSERT INTO respondents (id, kode, usia, jenis_kelamin, cahaya, consent_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);

  const insSample = db.prepare(`
    INSERT INTO samples (id, respondent_id, photo_file, model_version, ai_type_probs, ai_concern_probs, ai_type, ai_concerns)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insReview = db.prepare(`
    INSERT INTO reviews (id, sample_id, doctor_id, kualitas, tipe_kulit, masalah, catatan)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const dummyPresets = [
    { type: 'berminyak', concerns: ['jerawat', 'pori_besar'], docType: 'berminyak', docConcerns: ['jerawat', 'pori_besar'], qual: 'Baik' },
    { type: 'berminyak', concerns: ['jerawat'], docType: 'berminyak', docConcerns: ['jerawat'], qual: 'Baik' },
    { type: 'kering', concerns: ['kemerahan'], docType: 'kering', docConcerns: ['kemerahan'], qual: 'Baik' },
    { type: 'kering', concerns: ['kerutan'], docType: 'kering', docConcerns: ['kerutan'], qual: 'Cukup' },
    { type: 'normal', concerns: [], docType: 'normal', docConcerns: [], qual: 'Baik' },
    { type: 'normal', concerns: ['flek_hitam'], docType: 'normal', docConcerns: ['flek_hitam'], qual: 'Baik' },
    { type: 'kombinasi', concerns: ['pori_besar', 'flek_hitam'], docType: 'kombinasi', docConcerns: ['pori_besar'], qual: 'Baik' },
    { type: 'berminyak', concerns: ['jerawat'], docType: 'kombinasi', docConcerns: ['jerawat'], qual: 'Baik' }, // AI vs Doc beda tipe
    { type: 'kering', concerns: ['flek_hitam'], docType: 'kering', docConcerns: ['flek_hitam'], qual: 'Baik' },
    { type: 'normal', concerns: ['kerutan'], docType: null, docConcerns: [], qual: 'Tidak dapat dinilai' } // Kualitas buruk
  ];

  for (let i = 0; i < dummyPresets.length; i++) {
    const p = dummyPresets[i];
    const respId = uuidv4();
    const sampId = uuidv4();
    const kode = `DUMMY-R${(i + 1).toString().padStart(3, '0')}`;

    insResp.run(respId, kode, 20 + i, i % 2 === 0 ? 'Wanita' : 'Pria', 'Terang');

    // Buat probabilitas tipe AI
    const tp = [0.1, 0.1, 0.1, 0.1];
    const typeIdx = types.indexOf(p.type);
    tp[typeIdx] = 0.7;

    const cp = [0.1, 0.1, 0.1, 0.1, 0.1];
    p.concerns.forEach(c => {
      const idx = allConcerns.indexOf(c);
      if (idx !== -1) cp[idx] = 0.8;
    });

    insSample.run(
      sampId,
      respId,
      dummyFileName,
      'v1.0-onnx',
      JSON.stringify(tp),
      JSON.stringify(cp),
      p.type,
      JSON.stringify(p.concerns)
    );

    // Review Dokter 1 (dr. Indah)
    insReview.run(
      uuidv4(),
      sampId,
      doc1Id,
      p.qual,
      p.docType,
      JSON.stringify(p.docConcerns),
      'Catatan penilaian dummy dokter 1'
    );

    // Review Dokter 2 (dr. Budi) pada 6 sampel pertama (untuk simulasi multi-dokter & kesepakatan)
    if (i < 6) {
      const doc2Type = i === 1 ? 'kombinasi' : p.docType; // 1 sampel berbeda antar-dokter
      insReview.run(
        uuidv4(),
        sampId,
        doc2Id,
        'Baik',
        doc2Type,
        JSON.stringify(p.docConcerns),
        'Catatan penilaian dummy dokter 2'
      );
    }
  }

  console.log('✅ Berhasil memasukkan data DUMMY:');
  console.log('- 2 Dokter Dummy (dr. Indah & dr. Budi, password: "dokter123")');
  console.log('- 10 Sampel Dummy terdaftar dan dinilai');
  console.log('- 6 Sampel telah dinilai oleh 2 dokter untuk uji kesepakatan inter-rater');
}

seed().catch(console.error);
