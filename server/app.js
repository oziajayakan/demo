// server/app.js
// Express Server & API Backend untuk Sistem Analisis & Validasi Dokter
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');

const { db, photosDir } = require('./db');
const {
  wilsonConfidenceInterval,
  calculateCohensKappa,
  evaluateSkinTypes,
  evaluateSkinConcerns
} = require('./metrics');

const app = express();

// Konfigurasi limit body parser untuk mendukung transmisi foto base64 (maks 2MB)
app.use(express.json({ limit: '3mb' }));
app.use(express.urlencoded({ extended: true, limit: '3mb' }));
app.use(cookieParser('skripsi-skin-secret-key-2026'));

// Sesi sederhana berbasis cookie bertanda tangan (Signed Cookie)
function doctorAuthMiddleware(req, res, next) {
  const doctorId = req.signedCookies.doctor_id;
  if (!doctorId) {
    return res.status(401).json({ error: 'Sesi tidak valid atau telah berakhir. Silakan login kembali.' });
  }

  const doctor = db.prepare('SELECT id, nama, str_sip, instansi FROM doctors WHERE id = ?').get(doctorId);
  if (!doctor) {
    res.clearCookie('doctor_id');
    return res.status(401).json({ error: 'Akun dokter tidak ditemukan.' });
  }

  req.doctor = doctor;
  next();
}

// =========================================================================
// 1. ENDPOINT LIVENESS SESSION & TANTANGAN AKTIF (SERVER-SIDE NONCE)
// =========================================================================

// Penyimpanan sesi liveness aktif (nonce berlaku 60 detik, sekali pakai)
const activeLivenessSessions = new Map();

// Bersihkan sesi kedaluwarsa secara berkala
setInterval(() => {
  const now = Date.now();
  for (const [nonce, session] of activeLivenessSessions.entries()) {
    if (now - session.createdAt > 60000) {
      activeLivenessSessions.delete(nonce);
    }
  }
}, 15000);

const DAFTAR_TANTANGAN = [
  { id: 'blink', instruksi: 'Kedipkan kedua mata Anda', icon: '👁️' },
  { id: 'mouth', instruksi: 'Buka mulut Anda perlahan', icon: '😮' },
  { id: 'turn_left', instruksi: 'Tengokkan kepala ke KIRI', icon: '👈' },
  { id: 'turn_right', instruksi: 'Tengokkan kepala ke KANAN', icon: '👉' }
];

// Endpoint untuk meminta nonce & 2 tantangan acak sebelum memulai pemindaian
app.get('/api/liveness/start-session', (req, res) => {
  try {
    const nonce = uuidv4();
    // Acak 2 tantangan unik dari 4 opsi
    const shuffled = [...DAFTAR_TANTANGAN].sort(() => 0.5 - Math.random());
    const selectedChallenges = shuffled.slice(0, 2);

    activeLivenessSessions.set(nonce, {
      nonce,
      challenges: selectedChallenges.map(c => c.id),
      createdAt: Date.now()
    });

    return res.json({
      success: true,
      nonce,
      challenges: selectedChallenges,
      timeoutSeconds: 8,
      expiresIn: 60
    });
  } catch (err) {
    console.error('Error start liveness session:', err);
    return res.status(500).json({ error: 'Gagal membuat sesi liveness.' });
  }
});

// =========================================================================
// 2. ENDPOINT MODE PENELITIAN (PUBLIK / DARI INDEX.HTML)
// =========================================================================

// Simpan data sampel penelitian baru dari responden
app.post('/api/research/submit', (req, res) => {
  try {
    const {
      kode,
      usia,
      jenis_kelamin,
      cahaya,
      consent,
      photoBase64,
      ai_type_probs,
      ai_concern_probs,
      ai_type,
      ai_concerns,
      model_version,
      livenessProof // Bukti verifikasi server-side (nonce, completedChallenges, spoofScore)
    } = req.body;

    // Validasi consent wajib
    if (!consent) {
      return res.status(400).json({ error: 'Persetujuan penelitian (informed consent) wajib disetujui.' });
    }

    if (!kode || !kode.trim()) {
      return res.status(400).json({ error: 'Kode atau inisial responden wajib diisi.' });
    }

    // Validasi Liveness Server-Side Nonce
    if (!livenessProof || !livenessProof.nonce) {
      return res.status(400).json({ error: 'Bukti verifikasi liveness tidak ditemukan. Silakan ulangi pemindaian.' });
    }

    const session = activeLivenessSessions.get(livenessProof.nonce);
    if (!session) {
      return res.status(400).json({ error: 'Sesi verifikasi liveness kedaluwarsa atau tidak valid. Silakan scan ulang.' });
    }

    // Hapus sesi agar nonce menjadi sekali pakai (anti-replay attack)
    activeLivenessSessions.delete(livenessProof.nonce);

    // Cek batas kedaluwarsa 60 detik
    if (Date.now() - session.createdAt > 60000) {
      return res.status(400).json({ error: 'Sesi verifikasi liveness telah kedaluwarsa (>60 detik).' });
    }

    // Pastikan tantangan yang diselesaikan cocok dengan yang ditugaskan server
    const completed = Array.isArray(livenessProof.completedChallenges) ? livenessProof.completedChallenges : [];
    const isChallengesComplete = session.challenges.every(cId => completed.includes(cId));
    if (!isChallengesComplete) {
      return res.status(400).json({ error: 'Tantangan liveness aktif tidak terselesaikan secara lengkap.' });
    }

    if (!photoBase64 || !photoBase64.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Format foto wajah tidak valid.' });
    }

    // Ekstrak dan simpan file foto (maksimal 2MB)
    const matches = photoBase64.match(/^data:image\/([a-zA-Z+]+);base64,(.+)$/);
    if (!matches) {
      return res.status(400).json({ error: 'Encoding citra tidak dikenali.' });
    }

    const ext = matches[1] === 'png' ? 'png' : 'jpg';
    const buffer = Buffer.from(matches[2], 'base64');

    if (buffer.length > 2 * 1024 * 1024) {
      return res.status(400).json({ error: 'Ukuran foto melebihi batas maksimal 2 MB.' });
    }

    const photoFilename = `photo_${uuidv4()}.${ext}`;
    const photoPath = path.join(photosDir, photoFilename);
    fs.writeFileSync(photoPath, buffer);

    // Transaksi basis data untuk responden dan sampel
    const respId = uuidv4();
    const sampleId = uuidv4();

    const insertResp = db.prepare(`
      INSERT INTO respondents (id, kode, usia, jenis_kelamin, cahaya, consent_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(kode) DO UPDATE SET
        usia=excluded.usia,
        jenis_kelamin=excluded.jenis_kelamin,
        cahaya=excluded.cahaya,
        deleted_at=NULL
    `);

    // Dapatkan respondent id eksisting jika kode sudah pernah dipakai
    const existing = db.prepare('SELECT id FROM respondents WHERE kode = ?').get(kode.trim());
    const finalRespId = existing ? existing.id : respId;

    if (!existing) {
      insertResp.run(finalRespId, kode.trim(), usia ? parseInt(usia, 10) : null, jenis_kelamin || null, cahaya || 'Sedang');
    }

    const insertSample = db.prepare(`
      INSERT INTO samples (id, respondent_id, photo_file, model_version, ai_type_probs, ai_concern_probs, ai_type, ai_concerns)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertSample.run(
      sampleId,
      finalRespId,
      photoFilename,
      model_version || 'v1.0-onnx',
      JSON.stringify(ai_type_probs || []),
      JSON.stringify(ai_concern_probs || []),
      ai_type || 'normal',
      JSON.stringify(ai_concerns || [])
    );

    return res.json({
      success: true,
      message: 'Data penelitian berhasil tersimpan secara aman.',
      sampleId,
      kode: kode.trim()
    });
  } catch (err) {
    console.error('Error submit research:', err);
    return res.status(500).json({ error: 'Terjadi kesalahan internal server saat menyimpan data.' });
  }
});

// Responden dapat meminta penghapusan datanya (Hak Hapus Data Penelitian)
app.post('/api/research/delete-my-data', (req, res) => {
  try {
    const { kode } = req.body;
    if (!kode || !kode.trim()) {
      return res.status(400).json({ error: 'Kode responden wajib disertakan.' });
    }

    const resp = db.prepare('SELECT id FROM respondents WHERE kode = ? AND deleted_at IS NULL').get(kode.trim());
    if (!resp) {
      return res.status(404).json({ error: 'Data responden dengan kode tersebut tidak ditemukan atau telah dihapus.' });
    }

    // Ambil daftar file foto untuk dihapus dari storage disk
    const samples = db.prepare('SELECT photo_file FROM samples WHERE respondent_id = ?').all(resp.id);
    for (const s of samples) {
      const fPath = path.join(photosDir, s.photo_file);
      if (fs.existsSync(fPath)) {
        try { fs.unlinkSync(fPath); } catch (e) { /* ignore */ }
      }
    }

    // Hapus sampel dan tandai soft-delete/hapus responden
    db.prepare('DELETE FROM samples WHERE respondent_id = ?').run(resp.id);
    db.prepare('UPDATE respondents SET deleted_at = datetime(\'now\') WHERE id = ?').run(resp.id);

    return res.json({
      success: true,
      message: `Semua data foto dan hasil analisis untuk kode "${kode}" telah berhasil dihapus secara permanen.`
    });
  } catch (err) {
    console.error('Error delete data:', err);
    return res.status(500).json({ error: 'Gagal memproses penghapusan data.' });
  }
});

// =========================================================================
// 2. ENDPOINT DOKTER & BLIND REVIEW (/api/doctor/*)
// =========================================================================

// Login Dokter
app.post('/api/doctor/login', async (req, res) => {
  try {
    const { str_sip, password } = req.body;
    if (!str_sip || !password) {
      return res.status(400).json({ error: 'Nomor STR/SIP dan kata sandi wajib diisi.' });
    }

    const doctor = db.prepare('SELECT * FROM doctors WHERE str_sip = ?').get(str_sip.trim());
    if (!doctor) {
      return res.status(401).json({ error: 'Kombinasi STR/SIP atau kata sandi tidak sesuai.' });
    }

    const match = await bcrypt.compare(password, doctor.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Kombinasi STR/SIP atau kata sandi tidak sesuai.' });
    }

    // Set cookie sesi aman httpOnly
    res.cookie('doctor_id', doctor.id, {
      httpOnly: true,
      signed: true,
      maxAge: 8 * 3600 * 1000, // 8 jam kerja
      sameSite: 'lax'
    });

    return res.json({
      success: true,
      doctor: {
        id: doctor.id,
        nama: doctor.nama,
        str_sip: doctor.str_sip,
        instansi: doctor.instansi
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Terjadi kegagalan server saat proses login.' });
  }
});

// Logout Dokter
app.post('/api/doctor/logout', (req, res) => {
  res.clearCookie('doctor_id');
  return res.json({ success: true, message: 'Berhasil keluar.' });
});

// Profil dokter aktif
app.get('/api/doctor/me', doctorAuthMiddleware, (req, res) => {
  // Hitung progres ulasan dokter ini
  const totalSamples = db.prepare('SELECT COUNT(*) as cnt FROM samples').get().cnt;
  const reviewedByMe = db.prepare('SELECT COUNT(*) as cnt FROM reviews WHERE doctor_id = ?').get(req.doctor.id).cnt;

  return res.json({
    doctor: req.doctor,
    progress: {
      reviewed: reviewedByMe,
      total: totalSamples
    }
  });
});

// Antrean sampel acak untuk Blind Review (HANYA FOTO, HASIL AI DISEMBUNYIKAN SEPENUHNYA)
app.get('/api/doctor/queue', doctorAuthMiddleware, (req, res) => {
  // Ambil sampel yang BELUM pernah dinilai oleh dokter ini, diacak (RANDOM())
  const rows = db.prepare(`
    SELECT s.id, s.created_at
    FROM samples s
    WHERE s.id NOT IN (SELECT sample_id FROM reviews WHERE doctor_id = ?)
    ORDER BY RANDOM()
  `).all(req.doctor.id);

  const totalSamples = db.prepare('SELECT COUNT(*) as cnt FROM samples').get().cnt;
  const reviewedCount = db.prepare('SELECT COUNT(*) as cnt FROM reviews WHERE doctor_id = ?').get(req.doctor.id).cnt;

  // Pastikan respon HANYA berisi id sampel, tanpa info AI sedikitpun!
  return res.json({
    queue: rows,
    progress: {
      reviewed: reviewedCount,
      total: totalSamples
    }
  });
});

// Streaming Foto Sampel Terproteksi (Hanya Dokter yang login atau endpoint validasi yang dapat melihat)
app.get('/api/doctor/photo/:sampleId', doctorAuthMiddleware, (req, res) => {
  const { sampleId } = req.params;
  const sample = db.prepare('SELECT photo_file FROM samples WHERE id = ?').get(sampleId);
  if (!sample) {
    return res.status(404).send('Foto sampel tidak ditemukan.');
  }

  const fPath = path.join(photosDir, sample.photo_file);
  if (!fs.existsSync(fPath)) {
    return res.status(404).send('Berkas foto fisik tidak ditemukan pada penyimpanan.');
  }

  // Set header proteksi cache agar tidak tersimpan sembarangan
  res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
  return res.sendFile(fPath);
});

// Simpan Penilaian Dokter (Satu sampel hanya sekali dinilai per dokter)
app.post('/api/doctor/review', doctorAuthMiddleware, (req, res) => {
  try {
    const { sampleId, kualitas, tipe_kulit, masalah, catatan } = req.body;

    if (!sampleId) {
      return res.status(400).json({ error: 'ID sampel wajib disertakan.' });
    }

    if (!kualitas || !['Baik', 'Cukup', 'Tidak dapat dinilai'].includes(kualitas)) {
      return res.status(400).json({ error: 'Kualitas foto harus dipilih: Baik, Cukup, atau Tidak dapat dinilai.' });
    }

    if (kualitas !== 'Tidak dapat dinilai') {
      if (!tipe_kulit || !['normal', 'berminyak', 'kering', 'kombinasi'].includes(tipe_kulit)) {
        return res.status(400).json({ error: 'Tipe kulit harus dipilih salah satu untuk foto yang dapat dinilai.' });
      }
    }

    const reviewId = uuidv4();
    const finalTipe = kualitas === 'Tidak dapat dinilai' ? null : tipe_kulit;
    const finalMasalah = kualitas === 'Tidak dapat dinilai' ? [] : (masalah || []);

    const stmt = db.prepare(`
      INSERT INTO reviews (id, sample_id, doctor_id, kualitas, tipe_kulit, masalah, catatan)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      reviewId,
      sampleId,
      req.doctor.id,
      kualitas,
      finalTipe,
      JSON.stringify(finalMasalah),
      catatan ? catatan.trim() : null
    );

    return res.json({
      success: true,
      message: 'Penilaian klinis berhasil disimpan.'
    });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Anda sudah pernah menilai sampel ini sebelumnya.' });
    }
    console.error('Review submit error:', err);
    return res.status(500).json({ error: 'Gagal menyimpan ulasan ke database.' });
  }
});

// =========================================================================
// 3. ENDPOINT VALIDASI & METRIK STATISTIK (/api/validation/*)
// =========================================================================

// Dapatkan data agregasi metrik validasi
app.get('/api/validation/metrics', (req, res) => {
  try {
    const totalSamples = db.prepare('SELECT COUNT(*) as cnt FROM samples').get().cnt;
    const allReviews = db.prepare(`
      SELECT r.*, d.nama as doctor_nama, d.str_sip, d.instansi, s.ai_type, s.ai_concerns, s.photo_file
      FROM reviews r
      JOIN doctors d ON r.doctor_id = d.id
      JOIN samples s ON r.sample_id = s.id
    `).all();

    const distinctDoctors = db.prepare('SELECT id, nama, str_sip, instansi FROM doctors').all();
    const totalReviews = allReviews.length;

    // Filter ulasan valid (bukan 'Tidak dapat dinilai')
    const validReviews = allReviews.filter(r => r.kualitas !== 'Tidak dapat dinilai' && r.tipe_kulit);
    const unassessableCount = allReviews.filter(r => r.kualitas === 'Tidak dapat dinilai').length;

    // 1. Evaluasi Tipe Kulit AI vs Dokter (Semua review yang dapat dinilai)
    const typePairs = validReviews.map(r => ({
      ai: r.ai_type,
      doctor: r.tipe_kulit
    }));
    const typeEvaluation = evaluateSkinTypes(typePairs);

    // 2. Evaluasi Masalah Kulit AI vs Dokter (Biner)
    const concernPairs = validReviews.map(r => ({
      aiConcerns: JSON.parse(r.ai_concerns || '[]'),
      doctorConcerns: JSON.parse(r.masalah || '[]')
    }));
    const concernEvaluation = evaluateSkinConcerns(concernPairs);

    // 3. Analisis Kesepakatan Antar-Dokter (Inter-rater Agreement) jika >= 2 dokter
    // Kelompokkan ulasan berdasarkan sample_id
    const reviewsBySample = {};
    for (const r of allReviews) {
      if (!reviewsBySample[r.sample_id]) reviewsBySample[r.sample_id] = [];
      reviewsBySample[r.sample_id].push(r);
    }

    const multiDoctorSamples = [];
    const interRaterPairs = [];
    let needAdjudicationCount = 0;

    for (const [sId, rList] of Object.entries(reviewsBySample)) {
      if (rList.length >= 2) {
        // Ambil 2 ulasan dokter pertama untuk perhitungan inter-rater kappa
        const validDocList = rList.filter(r => r.kualitas !== 'Tidak dapat dinilai');
        if (validDocList.length >= 2) {
          interRaterPairs.push({
            rater1: validDocList[0].tipe_kulit,
            rater2: validDocList[1].tipe_kulit
          });

          // Cek apakah ada perbedaan pendapat antar dokter
          const firstType = validDocList[0].tipe_kulit;
          const isConflict = validDocList.some(v => v.tipe_kulit !== firstType);

          // Cek apakah sudah ada adjudikasi
          const adj = db.prepare('SELECT * FROM adjudications WHERE sample_id = ?').get(sId);

          if (isConflict && !adj) {
            needAdjudicationCount++;
          }

          multiDoctorSamples.push({
            sample_id: sId,
            doctors: validDocList.map(v => ({ nama: v.doctor_nama, tipe: v.tipe_kulit, masalah: JSON.parse(v.masalah || '[]') })),
            isConflict,
            adjudication: adj || null
          });
        }
      }
    }

    const interRaterKappa = calculateCohensKappa(interRaterPairs, ['berminyak', 'kering', 'normal', 'kombinasi']);

    // Generate kalimat ringkasan otomatis yang objektif dan jujur
    const doctorNames = Array.from(new Set(validReviews.map(r => r.doctor_nama))).join(', ');
    const doctorStrList = Array.from(new Set(validReviews.map(r => `${r.doctor_nama} (STR/SIP: ${r.str_sip})`))).join('; ');

    let summaryText = '';
    if (typeEvaluation.total === 0) {
      summaryText = 'Belum ada data sampel yang dinilai oleh dokter spesialis kulit.';
    } else {
      summaryText = `Pada ${typeEvaluation.total} sampel wajah yang berhasil divalidasi oleh dokter penilai (${doctorStrList}), kesesuaian klasifikasi tipe kulit AI mencapai ${typeEvaluation.accuracy}% (95% CI: ${typeEvaluation.ci95.lower}% - ${typeEvaluation.ci95.upper}%) dengan nilai kesepakatan Cohen's Kappa = ${typeEvaluation.kappa}. Sebanyak ${unassessableCount} sampel dinyatakan tidak dapat dinilai akibat faktor pencahayaan/kualitas citra dan dikecualikan dari perhitungan metrik akurasi.`;
    }

    return res.json({
      summary: {
        totalSamples,
        totalReviews,
        validReviewsCount: validReviews.length,
        unassessableCount,
        doctorsCount: distinctDoctors.length,
        doctorNames,
        summaryText
      },
      typeEvaluation,
      concernEvaluation,
      interRater: {
        multiDoctorSampleCount: multiDoctorSamples.length,
        interRaterKappa,
        needAdjudicationCount,
        multiDoctorSamples
      }
    });
  } catch (err) {
    console.error('Error validation metrics:', err);
    return res.status(500).json({ error: 'Gagal menghitung metrik validasi.' });
  }
});

// Adjudikasi keputusan untuk sampel yang memiliki perbedaan kesepakatan antar-dokter
app.post('/api/validation/adjudicate', (req, res) => {
  try {
    const { sampleId, decided_by, tipe_kulit, masalah, catatan } = req.body;
    if (!sampleId || !decided_by || !tipe_kulit) {
      return res.status(400).json({ error: 'Data adjudikasi belum lengkap.' });
    }

    const adjId = uuidv4();
    const stmt = db.prepare(`
      INSERT INTO adjudications (id, sample_id, decided_by, tipe_kulit, masalah, catatan)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(sample_id) DO UPDATE SET
        decided_by = excluded.decided_by,
        tipe_kulit = excluded.tipe_kulit,
        masalah = excluded.masalah,
        catatan = excluded.catatan,
        created_at = datetime('now')
    `);

    stmt.run(adjId, sampleId, decided_by.trim(), tipe_kulit, JSON.stringify(masalah || []), catatan ? catatan.trim() : null);

    return res.json({ success: true, message: 'Adjudikasi ground truth berhasil disimpan.' });
  } catch (err) {
    console.error('Error adjudication:', err);
    return res.status(500).json({ error: 'Gagal menyimpan adjudikasi.' });
  }
});

// Ekspor Data Mentah Lengkap (CSV tanpa foto)
app.get('/api/validation/export-csv', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT 
        s.id as sample_id,
        r.kode as responden_kode,
        r.usia as responden_usia,
        r.jenis_kelamin as responden_gender,
        r.cahaya as kondisi_cahaya,
        s.model_version,
        s.ai_type,
        s.ai_concerns,
        s.created_at as waktu_scan,
        d.nama as dokter_penilai,
        d.str_sip as dokter_str_sip,
        rev.kualitas as dokter_kualitas,
        rev.tipe_kulit as dokter_tipe_kulit,
        rev.masalah as dokter_masalah,
        rev.catatan as dokter_catatan,
        rev.created_at as waktu_penilaian
      FROM samples s
      JOIN respondents r ON s.respondent_id = r.id
      LEFT JOIN reviews rev ON s.id = rev.sample_id
      LEFT JOIN doctors d ON rev.doctor_id = d.id
      ORDER BY s.created_at DESC
    `).all();

    // Escape CSV cell helper
    const esc = val => {
      if (val === null || val === undefined) return '""';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    const headers = [
      'Sample ID', 'Kode Responden', 'Usia', 'Gender', 'Cahaya', 'Model AI',
      'Prediksi Tipe Kulit AI', 'Prediksi Masalah Kulit AI', 'Waktu Scan',
      'Dokter Penilai', 'STR / SIP Dokter', 'Kualitas Foto (Dokter)',
      'Tipe Kulit (Dokter)', 'Masalah Kulit (Dokter)', 'Catatan Dokter', 'Waktu Penilaian'
    ];

    let csv = headers.join(',') + '\r\n';
    for (const r of rows) {
      csv += [
        esc(r.sample_id),
        esc(r.responden_kode),
        esc(r.responden_usia),
        esc(r.responden_gender),
        esc(r.kondisi_cahaya),
        esc(r.model_version),
        esc(r.ai_type),
        esc(r.ai_concerns),
        esc(r.waktu_scan),
        esc(r.dokter_penilai),
        esc(r.dokter_str_sip),
        esc(r.dokter_kualitas),
        esc(r.dokter_tipe_kulit),
        esc(r.dokter_masalah),
        esc(r.dokter_catatan),
        esc(r.waktu_penilaian)
      ].join(',') + '\r\n';
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="data_validasi_skripsi.csv"');
    return res.send(csv);
  } catch (err) {
    console.error('Error export csv:', err);
    return res.status(500).send('Gagal mengekspor berkas CSV.');
  }
});

// =========================================================================
// 4. STATIS DAN ROUTING HALAMAN WEB
// =========================================================================

// Sajikan aset statis (labels.json, skin_model.onnx, html)
const staticDir = fs.existsSync(path.join(__dirname, '..', 'demoweb', 'index.html'))
  ? path.join(__dirname, '..', 'demoweb')
  : path.join(__dirname, '..');

app.use(express.static(staticDir));

// Halaman Penilaian Dokter
app.get('/dokter', (req, res) => {
  res.sendFile(path.join(staticDir, 'dokter.html'));
});

// Halaman Hasil Validasi & Akurasi
app.get('/validasi', (req, res) => {
  res.sendFile(path.join(staticDir, 'validasi.html'));
});

// Halaman Utama Scan / Mode Penelitian
app.get('/', (req, res) => {
  res.sendFile(path.join(staticDir, 'index.html'));
});

module.exports = app;
