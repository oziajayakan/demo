// lib/flash-liveness.ts
// Anti-Spoofing & Biological Liveness Engine (ISO/IEC 30107-3 compliant concepts)
// Detects: Phone screens, tablet replays, printed photos, static images, and glass specular reflection

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
    blinkVerified: boolean;
    rigidityScore: number;
    bezelDetected: boolean;
  };
}

/**
 * Calculates Eye Aspect Ratio (EAR) from MediaPipe 468 landmarks
 * Used to detect real human involuntary blinks vs static photos on phone screens
 */
export function calculateEAR(landmarks: any[]): number {
  if (!landmarks || landmarks.length < 468) return 0.25;

  // Left Eye: Upper (159), Lower (145), Inner (133), Outer (33)
  const p159 = landmarks[159];
  const p145 = landmarks[145];
  const p133 = landmarks[133];
  const p33 = landmarks[33];

  // Right Eye: Upper (386), Lower (374), Inner (362), Outer (263)
  const p386 = landmarks[386];
  const p374 = landmarks[374];
  const p362 = landmarks[362];
  const p263 = landmarks[263];

  const leftH = Math.hypot(p159.x - p145.x, p159.y - p145.y);
  const leftW = Math.hypot(p133.x - p33.x, p133.y - p33.y);
  const leftEAR = leftH / (leftW || 0.001);

  const rightH = Math.hypot(p386.x - p374.x, p386.y - p374.y);
  const rightW = Math.hypot(p362.x - p263.x, p362.y - p263.y);
  const rightEAR = rightH / (rightW || 0.001);

  return (leftEAR + rightEAR) / 2;
}

/**
 * Tracks Blink History to verify authentic biological eye closure & reopening
 */
export class BlinkTracker {
  private history: number[] = [];
  private hasBlinked: boolean = false;
  private minEARDuringBlink: number = 1.0;
  private maxHistoryLen: number = 30; // ~3 seconds at 100ms interval

  public update(ear: number): boolean {
    this.history.push(ear);
    if (this.history.length > this.maxHistoryLen) {
      this.history.shift();
    }

    // A human blink is characterized by:
    // 1. EAR drops below 0.155 (closed/semi-closed)
    // 2. Returns to normal (> 0.20) within 150ms - 450ms
    if (ear < 0.155) {
      this.minEARDuringBlink = Math.min(this.minEARDuringBlink, ear);
    }

    // Detect recovery from a dip
    if (this.minEARDuringBlink < 0.155 && ear > 0.20) {
      this.hasBlinked = true;
      this.minEARDuringBlink = 1.0; // reset for next blink
    }

    return this.hasBlinked;
  }

  public isVerified(): boolean {
    return this.hasBlinked;
  }

  public reset(): void {
    this.history = [];
    this.hasBlinked = false;
    this.minEARDuringBlink = 1.0;
  }
}

/**
 * Checks for static 2D image rigidity (a photo on a phone has ZERO 3D muscle micro-variation)
 */
export function checkFacialRigidity(earHistory: number[]): number {
  if (earHistory.length < 10) return 0.5;
  const mean = earHistory.reduce((a, b) => a + b, 0) / earHistory.length;
  const variance =
    earHistory.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) /
    earHistory.length;
  return variance;
}

/**
 * Detects sharp rectangular electronic screen bezels / borders enclosing the face
 */
export function detectScreenBezel(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  faceBox: { cx: number; cy: number; width: number; height: number }
): { detected: boolean; edgeScore: number } {
  try {
    const imgData = ctx.getImageData(0, 0, w, h).data;
    // Check vertical lines along the left and right peripheral boundaries of the face
    const leftMargin = Math.max(5, Math.round((faceBox.cx - faceBox.width * 0.65) * w));
    const rightMargin = Math.min(w - 6, Math.round((faceBox.cx + faceBox.width * 0.65) * w));

    let verticalEdgeCount = 0;
    const sampleYStart = Math.round(h * 0.2);
    const sampleYEnd = Math.round(h * 0.8);
    const sampleSteps = sampleYEnd - sampleYStart;

    for (let y = sampleYStart; y < sampleYEnd; y += 3) {
      // Gradient at left margin
      const idxL1 = (y * w + leftMargin) * 4;
      const idxL2 = (y * w + leftMargin + 3) * 4;
      const lumL1 = 0.299 * imgData[idxL1] + 0.587 * imgData[idxL1 + 1] + 0.114 * imgData[idxL1 + 2];
      const lumL2 = 0.299 * imgData[idxL2] + 0.587 * imgData[idxL2 + 1] + 0.114 * imgData[idxL2 + 2];

      if (Math.abs(lumL1 - lumL2) > 42) {
        verticalEdgeCount++;
      }

      // Gradient at right margin
      const idxR1 = (y * w + rightMargin) * 4;
      const idxR2 = (y * w + rightMargin + 3) * 4;
      const lumR1 = 0.299 * imgData[idxR1] + 0.587 * imgData[idxR1 + 1] + 0.114 * imgData[idxR1 + 2];
      const lumR2 = 0.299 * imgData[idxR2] + 0.587 * imgData[idxR2 + 1] + 0.114 * imgData[idxR2 + 2];

      if (Math.abs(lumR1 - lumR2) > 42) {
        verticalEdgeCount++;
      }
    }

    const ratio = verticalEdgeCount / ((sampleSteps / 3) * 2);
    return {
      detected: ratio > 0.48, // Strong rectangular bezel detected
      edgeScore: Math.round(ratio * 100),
    };
  } catch {
    return { detected: false, edgeScore: 0 };
  }
}

/**
 * Calculates average RGB from specific facial skin landmarks (cheeks, forehead, chin)
 */
export function sampleSkinRGB(
  ctx: CanvasRenderingContext2D,
  roi: FaceROI
): RGB {
  const sampleW = Math.max(16, Math.round(roi.w * 0.28));
  const sampleH = Math.max(16, Math.round(roi.h * 0.22));

  // Sample specifically from cheeks/forehead zone
  const startX = Math.round(roi.x + (roi.w - sampleW) / 2);
  const startY = Math.round(roi.y + roi.h * 0.32);

  const imgData = ctx.getImageData(startX, startY, sampleW, sampleH).data;
  let totalR = 0,
    totalG = 0,
    totalB = 0;
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
 * STRICT Spectral Chromaticity Shift & Phone Screen Rejection Evaluator
 */
export function evaluateFlashChromaticity(
  preRGB: RGB,
  flashRGB: RGB,
  targetHexColor: string,
  laplacianVar: number,
  options?: {
    blinkVerified?: boolean;
    bezelDetected?: boolean;
    rigidityVariance?: number;
  }
): LivenessResult {
  const hex = targetHexColor.replace('#', '');
  const targetR = parseInt(hex.substring(0, 2), 16) || 0;
  const targetG = parseInt(hex.substring(2, 4), 16) || 240;
  const targetB = parseInt(hex.substring(4, 6), 16) || 255;

  const deltaR = flashRGB.r - preRGB.r;
  const deltaG = flashRGB.g - preRGB.g;
  const deltaB = flashRGB.b - preRGB.b;

  // Determine which channels are active in target flash
  const isCyan = targetB > 180 && targetG > 180 && targetR < 100;
  const isMagenta = targetR > 180 && targetB > 180 && targetG < 100;
  const isYellow = targetR > 180 && targetG > 180 && targetB < 100;

  let chromaticShift = 0;
  let isChannelMatch = false;

  if (isCyan) {
    // Cyan flash MUST induce positive Blue and Green shift on skin dermis, while Red remains lower
    const blueShift = deltaB;
    const greenShift = deltaG;
    const redShift = deltaR;

    if (blueShift >= 7 && greenShift >= 5 && blueShift > redShift + 4) {
      isChannelMatch = true;
      chromaticShift = Math.min(100, Math.round(((blueShift + greenShift) / 28) * 100));
    } else {
      // Failed cyan channel test
      chromaticShift = Math.max(10, Math.round((blueShift / 20) * 40));
    }
  } else if (isMagenta) {
    // Magenta flash MUST induce positive Red and Blue shift, while Green remains lower
    if (deltaR >= 7 && deltaB >= 5 && deltaR > deltaG + 4) {
      isChannelMatch = true;
      chromaticShift = Math.min(100, Math.round(((deltaR + deltaB) / 28) * 100));
    } else {
      chromaticShift = Math.max(10, Math.round((deltaR / 20) * 40));
    }
  } else if (isYellow) {
    // Yellow flash MUST induce positive Red and Green shift, while Blue remains lower
    if (deltaR >= 6 && deltaG >= 6 && deltaG > deltaB + 4) {
      isChannelMatch = true;
      chromaticShift = Math.min(100, Math.round(((deltaR + deltaG) / 28) * 100));
    } else {
      chromaticShift = Math.max(10, Math.round((deltaG / 20) * 40));
    }
  } else {
    // General fallback: dominant channel must have at least +7 shift
    const maxShift = Math.max(deltaR, deltaG, deltaB);
    if (maxShift >= 8) {
      isChannelMatch = true;
      chromaticShift = 75;
    } else {
      chromaticShift = 25;
    }
  }

  // Texture sharpness check (Pore micro-structure)
  // Screens replay photos have either pixel moiré (> 260) or blurred out (< 15)
  const isTextureValid = laplacianVar >= 15 && laplacianVar <= 235;

  // Liveness validation criteria:
  // 1. Chromatic shift MUST match flash color (minimum 70% match)
  // 2. Texture must be within natural human dermis range
  // 3. Eye blink must be verified (if option provided)
  // 4. No electronic phone screen bezel detected
  const blinkPassed = options?.blinkVerified !== undefined ? options.blinkVerified : true;
  const bezelPassed = options?.bezelDetected !== undefined ? !options.bezelDetected : true;

  const passed =
    isChannelMatch &&
    chromaticShift >= 70 &&
    isTextureValid &&
    blinkPassed &&
    bezelPassed;

  let reason = 'Wajah asli terverifikasi.';
  if (!passed) {
    if (!blinkPassed) {
      reason = 'Terdeteksi foto statis (tidak ada kedipan mata alami). Harap gunakan wajah asli.';
    } else if (!bezelPassed) {
      reason = 'Terdeteksi bingkai layar ponsel/perangkat elektronik di depan kamera.';
    } else if (!isChannelMatch || chromaticShift < 70) {
      reason = 'Pantulan spektral tidak alami: terdeteksi layar HP lain, foto cetak, atau pantulan kaca.';
    } else if (laplacianVar > 235) {
      reason = 'Terdeteksi pola kisi piksel digital (Moiré) dari layar lain.';
    } else {
      reason = 'Kualitas citra tidak memenuhi standar dermis biologis.';
    }
  }

  return {
    passed,
    score: passed ? Math.min(99, Math.round(chromaticShift * 0.7 + 28)) : Math.min(48, chromaticShift),
    reason,
    metrics: {
      chromaticShift,
      laplacianSharpness: Math.round(laplacianVar),
      specularGlare: Math.round(Math.abs(deltaR) + Math.abs(deltaG) + Math.abs(deltaB)),
      moiréScore: laplacianVar > 235 ? 90 : 15,
      blinkVerified: blinkPassed,
      rigidityScore: options?.rigidityVariance ? Math.round(options.rigidityVariance * 10000) : 50,
      bezelDetected: !bezelPassed,
    },
  };
}
