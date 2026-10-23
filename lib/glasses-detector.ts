// lib/glasses-detector.ts
// Precision Multi-Feature Glasses & Eye Occlusion Detection Engine

export interface Landmark {
  x: number;
  y: number;
  z?: number;
}

export interface GlassesCheckResult {
  pass: boolean;
  msg: string;
  wearingGlasses: boolean;
  hasPhysicalBridge: boolean;
  rimSignals: number;
  glares: number;
}

function getLum(data: Uint8ClampedArray, idx: number): number {
  return 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
}

/**
 * Extracts a sub-patch of pixels around (cx, cy) from video or canvas
 */
function samplePatch(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  sz: number
): Uint8ClampedArray {
  const half = Math.floor(sz / 2);
  const x = Math.max(0, Math.floor(cx - half));
  const y = Math.max(0, Math.floor(cy - half));
  return ctx.getImageData(x, y, sz, sz).data;
}

/**
 * Checks whether the user is wearing glasses using 468 MediaPipe facial landmarks
 */
export function checkGlassesWithLandmarks(
  landmarks: Landmark[],
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number
): GlassesCheckResult {
  if (!landmarks || landmarks.length < 468) {
    return {
      pass: false,
      msg: 'Wajah belum terdeteksi stabil',
      wearingGlasses: false,
      hasPhysicalBridge: false,
      rimSignals: 0,
      glares: 0,
    };
  }

  const samplePoint = (pt: Landmark, sz = 16) => {
    const d = samplePatch(ctx, pt.x * w, pt.y * h, sz);
    let s = 0,
      min = 255,
      max = 0,
      edge = 0;
    const count = sz * sz;
    for (let i = 0; i < count; i++) {
      const v = getLum(d, i * 4);
      s += v;
      if (v < min) min = v;
      if (v > max) max = v;
      if (i % sz < sz - 1) edge += Math.abs(v - getLum(d, i * 4 + 4));
    }
    return { avg: s / count, min, max, span: max - min, edge: edge / count };
  };

  // A. Nose Bridge Analysis (Landmarks 168 & 6 vs Dahi 9 & Ujung Hidung 4)
  const b168 = samplePoint(landmarks[168], 16);
  const b6 = samplePoint(landmarks[6], 16);
  const f9 = samplePoint(landmarks[9], 20);
  const t4 = samplePoint(landmarks[4], 20);

  const skinBright = Math.max(f9.avg, t4.avg);
  const minBridgeLum = Math.min(b168.avg, b6.avg);
  const maxBridgeSpan = Math.max(b168.span, b6.span);
  const maxBridgeEdge = Math.max(b168.edge, b6.edge);

  // Eyeglass bridge creates high-contrast dark line across the nose root
  const bridgeDarkDrop = skinBright - minBridgeLum;
  const hasPhysicalBridge =
    (bridgeDarkDrop > 26 && maxBridgeEdge > 8.0) ||
    (maxBridgeSpan > 54 && maxBridgeEdge > 9.5);

  // B. Infraorbital Rim Detection (Under-eye & Outer Eye Frames)
  // Landmarks: 111 & 340 (infraorbital), 226 & 446 (outer frame rims)
  const rimPoints = [111, 340, 226, 446];
  let rimSignals = 0;
  for (const idx of rimPoints) {
    const pt = landmarks[idx];
    if (!pt) continue;
    const pD = samplePatch(ctx, pt.x * w, pt.y * h, 18);
    let pMin = 255,
      pMax = 0,
      pVeryDark = 0,
      pEdge = 0;
    const count = 18 * 18;
    for (let i = 0; i < count; i++) {
      const v = getLum(pD, i * 4);
      if (v < pMin) pMin = v;
      if (v > pMax) pMax = v;
      if (v < 55) pVeryDark++;
      if (i % 18 < 17) pEdge += Math.abs(v - getLum(pD, i * 4 + 4));
    }
    // Eyeglass frames create very dark boundary pixels and sharp edges
    if (
      (pMax - pMin > 52 && pVeryDark >= 4) ||
      (pVeryDark >= 7 && pEdge / count > 10)
    ) {
      rimSignals++;
    }
  }

  // C. Lens Specular Glare & Anti-Reflective Coating Reflection
  const eyePts = [159, 145, 33, 133, 386, 374, 362, 263];
  let glares = 0;
  for (const idx of eyePts) {
    const pt = landmarks[idx];
    if (!pt) continue;
    const d = samplePatch(ctx, pt.x * w, pt.y * h, 18);
    const count = 18 * 18;
    for (let i = 0; i < count; i++) {
      const r = d[i * 4];
      const g = d[i * 4 + 1];
      const b = d[i * 4 + 2];
      // Specular white reflection or cyan/green lens coating reflection
      const isWhiteSpecular = r > 218 && g > 218 && b > 218;
      const isCoatingTint = g > 135 && g - r > 20 && b > 105;
      if (isWhiteSpecular || isCoatingTint) {
        glares++;
        break;
      }
    }
  }

  // Decision rule
  const wearingGlasses =
    (hasPhysicalBridge && rimSignals >= 1) ||
    rimSignals >= 2 ||
    (hasPhysicalBridge && glares >= 1) ||
    glares >= 3 ||
    (bridgeDarkDrop > 34 && maxBridgeSpan > 45);

  return {
    pass: !wearingGlasses,
    msg: wearingGlasses
      ? 'Mohon lepas kacamata Anda agar area mata dan kulit terbaca'
      : 'Bebas kacamata',
    wearingGlasses,
    hasPhysicalBridge,
    rimSignals,
    glares,
  };
}

/**
 * Fallback optical CV checker when MediaPipe landmarks are not yet loaded
 * Inspects nose bridge dark drop & specular reflections in standard eye region
 */
export function checkGlassesFallback(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number
): GlassesCheckResult {
  // Focus on center 30% of canvas, upper half (where eyes and bridge are located)
  const eyeY = Math.round(h * 0.38);
  const midX = Math.round(w * 0.5);

  // Sample forehead (reference skin)
  const foreheadD = ctx.getImageData(midX - 15, Math.round(h * 0.22), 30, 20).data;
  let foreheadLum = 0;
  for (let i = 0; i < foreheadD.length; i += 4) {
    foreheadLum += getLum(foreheadD, i);
  }
  foreheadLum /= foreheadD.length / 4;

  // Sample nose bridge
  const bridgeD = ctx.getImageData(midX - 12, eyeY, 24, 16).data;
  let minBridge = 255,
    bridgeLum = 0,
    darkPixels = 0;
  for (let i = 0; i < bridgeD.length; i += 4) {
    const l = getLum(bridgeD, i);
    bridgeLum += l;
    if (l < minBridge) minBridge = l;
    if (l < 55) darkPixels++;
  }
  bridgeLum /= bridgeD.length / 4;

  // Sample left and right eye areas for lens glare
  const leftEyeD = ctx.getImageData(Math.round(w * 0.35), eyeY - 10, 24, 24).data;
  const rightEyeD = ctx.getImageData(Math.round(w * 0.55), eyeY - 10, 24, 24).data;

  let glares = 0;
  for (let i = 0; i < leftEyeD.length; i += 4) {
    if (leftEyeD[i] > 225 && leftEyeD[i + 1] > 225 && leftEyeD[i + 2] > 225) glares++;
  }
  for (let i = 0; i < rightEyeD.length; i += 4) {
    if (rightEyeD[i] > 225 && rightEyeD[i + 1] > 225 && rightEyeD[i + 2] > 225) glares++;
  }

  const drop = foreheadLum - bridgeLum;
  const wearingGlasses =
    (drop > 28 && darkPixels >= 8) ||
    darkPixels >= 22 ||
    (drop > 22 && glares >= 12);

  return {
    pass: !wearingGlasses,
    msg: wearingGlasses
      ? 'Mohon lepas kacamata Anda agar area mata dan kulit terbaca'
      : 'Bebas kacamata',
    wearingGlasses,
    hasPhysicalBridge: drop > 28,
    rimSignals: darkPixels > 10 ? 1 : 0,
    glares,
  };
}
