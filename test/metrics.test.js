// test/metrics.test.js
// Unit test mandiri untuk fungsi hitung metrik statistik validasi
// Menguji Wilson Interval, Cohen's Kappa, Confusion Matrix, dan Sensitivitas/Spesifisitas

const assert = require('assert');
const {
  wilsonConfidenceInterval,
  calculateCohensKappa,
  evaluateSkinTypes,
  evaluateSkinConcerns
} = require('../server/metrics');

console.log('--- Menjalankan Unit Test Metrik Validasi ---');

// 1. Tes Wilson Confidence Interval
{
  // Contoh: 80 sukses dari 100 sampel (80%)
  const ci = wilsonConfidenceInterval(80, 100);
  console.log('1. Wilson CI (80/100):', ci);
  assert(ci.p === 80, 'Proporsi harus 80%');
  assert(ci.lower >= 70 && ci.lower <= 75, `Lower bound harus sekitar 71%: didapat ${ci.lower}`);
  assert(ci.upper >= 85 && ci.upper <= 90, `Upper bound harus sekitar 87%: didapat ${ci.upper}`);
  console.log('   ✅ Wilson CI lulus');
}

// 2. Tes Cohen's Kappa Sempurna & Biasa
{
  // Kesepakatan sempurna
  const perfect = [
    { rater1: 'berminyak', rater2: 'berminyak' },
    { rater1: 'kering', rater2: 'kering' },
    { rater1: 'normal', rater2: 'normal' },
    { rater1: 'kombinasi', rater2: 'kombinasi' }
  ];
  const classes = ['berminyak', 'kering', 'normal', 'kombinasi'];
  const kPerf = calculateCohensKappa(perfect, classes);
  assert.strictEqual(kPerf, 1, 'Kappa kesepakatan sempurna harus 1.0');

  // Contoh data berpasangan dengan ketidaksepakatan
  const pairs = [
    { rater1: 'berminyak', rater2: 'berminyak' },
    { rater1: 'berminyak', rater2: 'berminyak' },
    { rater1: 'kering', rater2: 'kering' },
    { rater1: 'normal', rater2: 'normal' },
    { rater1: 'kombinasi', rater2: 'berminyak' } // 1 beda dari 5
  ];
  const kVal = calculateCohensKappa(pairs, classes);
  console.log('2. Cohen Kappa (4/5 sepakat):', kVal);
  assert(kVal > 0.6 && kVal < 1.0, 'Kappa harus bernilai substansial');
  console.log('   ✅ Cohen Kappa lulus');
}

// 3. Tes Evaluasi Tipe Kulit (Multikelas)
{
  const data = [
    { ai: 'berminyak', doctor: 'berminyak' },
    { ai: 'berminyak', doctor: 'berminyak' },
    { ai: 'kering', doctor: 'kering' },
    { ai: 'normal', doctor: 'kombinasi' } // AI salah
  ];
  const evalResult = evaluateSkinTypes(data);
  console.log('3. Evaluasi Tipe Kulit:', {
    total: evalResult.total,
    correct: evalResult.correct,
    accuracy: evalResult.accuracy,
    kappa: evalResult.kappa
  });
  assert.strictEqual(evalResult.total, 4);
  assert.strictEqual(evalResult.correct, 3);
  assert.strictEqual(evalResult.accuracy, 75); // 3/4 = 75%
  assert.strictEqual(evalResult.matrix['berminyak']['berminyak'], 2);
  assert.strictEqual(evalResult.matrix['kombinasi']['normal'], 1);
  assert.strictEqual(evalResult.classesMetric['berminyak'].precision, 1);
  console.log('   ✅ Evaluasi Tipe Kulit lulus');
}

// 4. Tes Evaluasi Masalah Kulit (Biner per kelas)
{
  const concernData = [
    { aiConcerns: ['jerawat', 'kemerahan'], doctorConcerns: ['jerawat'] },        // Jerawat TP, Kemerahan FP
    { aiConcerns: ['jerawat'], doctorConcerns: ['jerawat', 'kemerahan'] },        // Jerawat TP, Kemerahan FN
    { aiConcerns: [], doctorConcerns: [] },                                       // Keduanya TN untuk jerawat & kemerahan
    { aiConcerns: ['flek_hitam'], doctorConcerns: ['flek_hitam'] }                // Flek TP
  ];

  const resConcerns = evaluateSkinConcerns(concernData);
  console.log('4. Evaluasi Masalah Kulit (Jerawat):', resConcerns.jerawat);
  // Jerawat: doctor positif di 2 kasus, AI positif di 2 kasus. Keduanya cocok -> TP=2, FP=0, TN=2, FN=0.
  assert.strictEqual(resConcerns.jerawat.tp, 2);
  assert.strictEqual(resConcerns.jerawat.fp, 0);
  assert.strictEqual(resConcerns.jerawat.fn, 0);
  assert.strictEqual(resConcerns.jerawat.sensitivity, 1); // 2/2 = 1.0

  // Kemerahan: doctor positif di index 1 (FN) & AI positif di index 0 (FP)
  assert.strictEqual(resConcerns.kemerahan.tp, 0);
  assert.strictEqual(resConcerns.kemerahan.fp, 1);
  assert.strictEqual(resConcerns.kemerahan.fn, 1);
  assert.strictEqual(resConcerns.kemerahan.sensitivity, 0);
  console.log('   ✅ Evaluasi Masalah Kulit lulus');
}

console.log('\nSEMUA UNIT TEST METRIK STATISTIK BERHASIL (PASSED)! 🎉');
