// lib/flash-liveness.ts
// Dynamic Screen Flash & Anti-Spoofing Detection Engine

export interface FaceROI {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface LivenessResult {
  passed: boolean;
  score: number;
  reason?: string;
  metrics: {
    chromaticShift: number;
    laplacianSharpness: number;
    specularGlare: number;
    moiréScore: number;
  };
}

/**
 * Calculates average RGB from a specific canvas context region
 */
export function sampleSkinRGB(
  ctx: CanvasRenderingContext2D,
  roi: FaceROI
): RGB {
  const sampleW = Math.max(16, Math.round(roi.w * 0.3));
  const sampleH = Math.max(16, Math.round(roi.h * 0.25));
  // Sample from forehead / cheek area
  const startX = Math.round(roi.x + (roi.w - sampleW) / 2);
  const startY = Math.round(roi.y + roi.h * 0.35);

  const imgData = ctx.getImageData(startX, startY, sampleW, sampleH).data;
  let totalR = 0, totalG = 0, totalB = 0;
  const count = imgData.length / 4;

  for (let i = 0; i < imgData.length; i += 4) {
    totalR += imgData[i];
    totalG += imgData[i + 1];
    totalB += imgData[i + 2];
  }

  return {
    r: count ? totalR / count : 0,
    g: count ? totalG / count : 0,
    b: count ? totalB / count : 0,
  };
}

/**
 * Computes Laplacian variance for skin pore texture & sharpness
 */
export function computeLaplacianVariance(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number
): number {
  const d = ctx.getImageData(0, 0, w, h).data;
  const gray = new Float32Array(w * h);

  for (let i = 0; i < w * h; i++) {
    gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  }

  let sum = 0;
  let sumSq = 0;
  let count = 0;

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      // 3x3 Laplacian operator kernel
      const lap =
        4 * gray[idx] -
        gray[idx - 1] -
        gray[idx + 1] -
        gray[idx - w] -
        gray[idx + w];
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }

  if (count === 0) return 0;
  const mean = sum / count;
  return sumSq / count - mean * mean;
}

/**
 * Evaluates the spectral chromaticity shift between ambient frame and flash frame
 */
export function evaluateFlashChromaticity(
  preRGB: RGB,
  flashRGB: RGB,
  targetHexColor: string,
  laplacianVar: number
): LivenessResult {
  // Convert hex flash color to normalized RGB
  const hex = targetHexColor.replace('#', '');
  const targetR = parseInt(hex.substring(0, 2), 16) || 255;
  const targetG = parseInt(hex.substring(2, 4), 16) || 255;
  const targetB = parseInt(hex.substring(4, 6), 16) || 255;

  const deltaR = flashRGB.r - preRGB.r;
  const deltaG = flashRGB.g - preRGB.g;
  const deltaB = flashRGB.b - preRGB.b;

  // Expected dominant channel
  const maxTarget = Math.max(targetR, targetG, targetB);
  const isRedDominant = targetR === maxTarget;
  const isGreenDominant = targetG === maxTarget;
  const isBlueDominant = targetB === maxTarget;

  let chromaticMatch = 0;
  if (isBlueDominant && deltaB > deltaR && deltaB > deltaG) {
    chromaticMatch += 0.45;
  } else if (isRedDominant && deltaR > deltaB) {
    chromaticMatch += 0.45;
  } else if (isGreenDominant && deltaG > deltaR) {
    chromaticMatch += 0.45;
  } else {
    // Diffuse shift check
    const totalDelta = Math.abs(deltaR) + Math.abs(deltaG) + Math.abs(deltaB);
    if (totalDelta > 12) chromaticMatch += 0.3;
  }

  // Check overall luminance change (real skin brightens smoothly)
  const lumaPre = 0.299 * preRGB.r + 0.587 * preRGB.g + 0.114 * preRGB.b;
  const lumaFlash = 0.299 * flashRGB.r + 0.587 * flashRGB.g + 0.114 * flashRGB.b;
  const lumaDelta = lumaFlash - lumaPre;

  if (lumaDelta > 4 && lumaDelta < 65) {
    chromaticMatch += 0.35;
  }

  // Texture score from Laplacian variance
  // Screen replay usually has unnatural high frequency moiré (> 280) or extreme blur (< 12)
  let textureScore = 0.2;
  if (laplacianVar >= 14 && laplacianVar <= 250) {
    textureScore = 0.35;
  }

  const finalScore = Math.min(1.0, chromaticMatch + textureScore);
  const passed = finalScore >= 0.55 && laplacianVar >= 12;

  let reason = 'Wajah asli terverifikasi.';
  if (!passed) {
    if (laplacianVar < 12) {
      reason = 'Citra terlalu buram atau tidak fokus.';
    } else if (laplacianVar > 260) {
      reason = 'Terdeteksi pola kisi layar digital (Moiré). Hadapkan wajah asli.';
    } else {
      reason = 'Pantulan cahaya tidak alami (indikasi foto cetak / layar digital).';
    }
  }

  return {
    passed,
    score: Math.round(finalScore * 100),
    reason,
    metrics: {
      chromaticShift: Math.round(chromaticMatch * 100),
      laplacianSharpness: Math.round(laplacianVar),
      specularGlare: Math.round(lumaDelta),
      moiréScore: laplacianVar > 250 ? 85 : 10,
    },
  };
}
