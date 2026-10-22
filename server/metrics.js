// server/metrics.js
// Perhitungan metrik validasi statistik:
// 1. Akurasi & Wilson 95% Confidence Interval
// 2. Confusion Matrix 4x4 & Precision / Recall / F1 per kelas
// 3. Cohen's Kappa (AI vs Dokter atau Antar-Dokter)
// 4. Sensitivitas, Spesifisitas, Presisi, F1 untuk Masalah Kulit (Biner per kelas)

/**
 * Menghitung Wilson Score Interval 95% untuk proporsi p = x / n
 * @param {number} x - Jumlah sukses / benar
 * @param {number} n - Total observasi
 * @returns {{ lower: number, upper: number, p: number }}
 */
function wilsonConfidenceInterval(x, n, z = 1.95996) {
  if (n <= 0) return { lower: 0, upper: 0, p: 0 };
  const p = x / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centreAdjusted = p + z2 / (2 * n);
  const adjustedStdDev = Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);

  const lower = Math.max(0, (centreAdjusted - z * adjustedStdDev) / denominator);
  const upper = Math.min(1, (centreAdjusted + z * adjustedStdDev) / denominator);

  return {
    lower: Math.round(lower * 10000) / 100, // persentase 2 desimal
    upper: Math.round(upper * 10000) / 100,
    p: Math.round(p * 10000) / 100
  };
}

/**
 * Menghitung Cohen's Kappa untuk dua rater (misal AI vs Dokter atau Dokter A vs Dokter B)
 * @param {Array<{rater1: string, rater2: string}>} pairs
 * @param {Array<string>} classes
 * @returns {number} Nilai kappa (-1 sampai 1)
 */
function calculateCohensKappa(pairs, classes) {
  const n = pairs.length;
  if (n === 0) return 0;

  // Frekuensi observasi
  let poMatches = 0;
  const countRater1 = {};
  const countRater2 = {};
  for (const c of classes) {
    countRater1[c] = 0;
    countRater2[c] = 0;
  }

  for (const pair of pairs) {
    if (pair.rater1 === pair.rater2) {
      poMatches++;
    }
    if (countRater1[pair.rater1] !== undefined) countRater1[pair.rater1]++;
    if (countRater2[pair.rater2] !== undefined) countRater2[pair.rater2]++;
  }

  const Po = poMatches / n;

  // Expected agreement Pe
  let Pe = 0;
  for (const c of classes) {
    const p1 = (countRater1[c] || 0) / n;
    const p2 = (countRater2[c] || 0) / n;
    Pe += p1 * p2;
  }

  if (Pe === 1) return 1; // Semua rater sepakat sempurna
  const kappa = (Po - Pe) / (1 - Pe);
  return Math.round(kappa * 1000) / 1000;
}

/**
 * Evaluasi Klasifikasi Multikelas (Tipe Kulit)
 * @param {Array<{ai: string, doctor: string}>} items
 * @param {Array<string>} classes - Default: ['berminyak', 'kering', 'normal', 'kombinasi']
 */
function evaluateSkinTypes(items, classes = ['berminyak', 'kering', 'normal', 'kombinasi']) {
  const n = items.length;
  if (n === 0) {
    return {
      total: 0,
      accuracy: 0,
      ci95: { lower: 0, upper: 0, p: 0 },
      kappa: 0,
      matrix: {},
      classesMetric: {}
    };
  }

  // Bangun Confusion Matrix: matrix[actualDoctor][predictedAI]
  const matrix = {};
  for (const actual of classes) {
    matrix[actual] = {};
    for (const pred of classes) {
      matrix[actual][pred] = 0;
    }
  }

  let correct = 0;
  for (const item of items) {
    const act = item.doctor;
    const pred = item.ai;
    if (matrix[act] && matrix[act][pred] !== undefined) {
      matrix[act][pred]++;
    }
    if (act === pred) correct++;
  }

  const accuracyPct = Math.round((correct / n) * 10000) / 100;
  const ci95 = wilsonConfidenceInterval(correct, n);

  // Precision, Recall, F1 per kelas
  const classesMetric = {};
  for (const c of classes) {
    // TP: actual = c, pred = c
    const tp = matrix[c] ? matrix[c][c] : 0;

    // FP: actual != c, pred = c (jumlah kolom pred = c kecuali baris c)
    let fp = 0;
    for (const other of classes) {
      if (other !== c && matrix[other]) {
        fp += matrix[other][c] || 0;
      }
    }

    // FN: actual = c, pred != c (jumlah baris actual = c kecuali kolom c)
    let fn = 0;
    if (matrix[c]) {
      for (const other of classes) {
        if (other !== c) {
          fn += matrix[c][other] || 0;
        }
      }
    }

    const totalActual = tp + fn; // Jumlah sampel kelas c menurut ground truth dokter
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    classesMetric[c] = {
      tp,
      fp,
      fn,
      totalActual,
      precision: Math.round(precision * 1000) / 1000,
      recall: Math.round(recall * 1000) / 1000,
      f1: Math.round(f1 * 1000) / 1000
    };
  }

  // Kappa AI vs Dokter
  const pairs = items.map(it => ({ rater1: it.ai, rater2: it.doctor }));
  const kappa = calculateCohensKappa(pairs, classes);

  return {
    total: n,
    correct,
    accuracy: accuracyPct,
    ci95,
    kappa,
    matrix,
    classesMetric
  };
}

/**
 * Evaluasi Masalah Kulit (Biner per kelas)
 * @param {Array<{aiConcerns: Array<string>, doctorConcerns: Array<string>}>} items
 * @param {Array<string>} concernList - Default: ['jerawat', 'flek_hitam', 'kemerahan', 'pori_besar', 'kerutan']
 */
function evaluateSkinConcerns(items, concernList = ['jerawat', 'flek_hitam', 'kemerahan', 'pori_besar', 'kerutan']) {
  const result = {};
  const n = items.length;

  for (const c of concernList) {
    if (n === 0) {
      result[c] = {
        total: 0,
        cases: 0,
        tp: 0,
        fp: 0,
        tn: 0,
        fn: 0,
        sensitivity: 0,
        specificity: 0,
        precision: 0,
        f1: 0,
        accuracy: 0
      };
      continue;
    }

    let tp = 0, fp = 0, tn = 0, fn = 0;
    for (const item of items) {
      const hasDoctor = (item.doctorConcerns || []).includes(c);
      const hasAI = (item.aiConcerns || []).includes(c);

      if (hasDoctor && hasAI) tp++;
      else if (!hasDoctor && hasAI) fp++;
      else if (!hasDoctor && !hasAI) tn++;
      else if (hasDoctor && !hasAI) fn++;
    }

    const cases = tp + fn; // Kasus positif menurut dokter
    const sensitivity = tp + fn > 0 ? tp / (tp + fn) : 0; // Recall
    const specificity = tn + fp > 0 ? tn / (tn + fp) : 0;
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const f1 = precision + sensitivity > 0 ? (2 * precision * sensitivity) / (precision + sensitivity) : 0;
    const accuracy = (tp + tn) / n;

    result[c] = {
      total: n,
      cases,
      tp,
      fp,
      tn,
      fn,
      sensitivity: Math.round(sensitivity * 1000) / 1000,
      specificity: Math.round(specificity * 1000) / 1000,
      precision: Math.round(precision * 1000) / 1000,
      f1: Math.round(f1 * 1000) / 1000,
      accuracy: Math.round(accuracy * 1000) / 1000
    };
  }

  return result;
}

module.exports = {
  wilsonConfidenceInterval,
  calculateCohensKappa,
  evaluateSkinTypes,
  evaluateSkinConcerns
};
