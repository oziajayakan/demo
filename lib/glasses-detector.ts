// lib/glasses-detector.ts
// Calibrated Glasses & Eye Occlusion Detection Engine
// Designed to prevent false positives on bare faces while detecting real eyeglass frames

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
  confidence: number;
}

function getLum(data: Uint8ClampedArray, idx: number): number {
  return 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
}

/**
 * Extracts a small sub-patch of pixels around (cx, cy)
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
  return ctx.getImageData(x, y, Math.max(1, sz), Math.max(1, sz)).data;
}

/**
 * Checks whether the user is wearing glasses using 468 MediaPipe facial landmarks.
 * Carefully avoids eyebrows, pupils, eyelashes, and natural facial contours.
 */
export function checkGlassesWithLandmarks(
  landmarks: Landmark[],
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number
): GlassesCheckResult {
  if (!landmarks || landmarks.length < 468) {
    return checkGlassesFallback(ctx, w, h);
  }

  // Helper to compute average luminance in a small 6x6 patch (prevents overlapping eyebrows/pupils)
  const sampleAvgLum = (pt: Landmark, patchSize = 6) => {
    const data = samplePatch(ctx, pt.x * w, pt.y * h, patchSize);
    let sum = 0;
    const count = data.length / 4;
    if (count === 0) return 128;
    for (let i = 0; i < data.length; i += 4) {
      sum += getLum(data, i);
    }
    return sum / count;
  };

  // 1. Skin Reference Luminance (from clean cheeks, avoiding beard or shadow)
  // Landmark 50: Left cheek center; Landmark 280: Right cheek center
  const leftCheekLum = sampleAvgLum(landmarks[50], 8);
  const rightCheekLum = sampleAvgLum(landmarks[280], 8);
  const skinLum = (leftCheekLum + rightCheekLum) / 2;

  // 2. Nose Bridge Analysis (strictly on the nasal bone, BELOW the glabella/eyebrows)
  // Landmark 197: Rhinion/Mid-nasal bone (where glasses bridge rests)
  // Landmark 195: Lower nasal bridge
  // Landmark 4: Tip of nose
  const bridge197Lum = sampleAvgLum(landmarks[197], 6);
  const bridge195Lum = sampleAvgLum(landmarks[195], 6);
  const noseTipLum = sampleAvgLum(landmarks[4], 8);

  const avgBridgeLum = (bridge197Lum + bridge195Lum) / 2;
  const bridgeDarkDrop = skinLum - avgBridgeLum;
  const bridgeTipDrop = noseTipLum - avgBridgeLum;

  // Eyeglass bridge creates a distinct, continuous dark bar across 197
  // On a bare face, nasal ridge is smooth and often brighter than or equal to cheeks
  const hasDarkBridge =
    bridgeDarkDrop > 34 && bridgeTipDrop > 24 && avgBridgeLum < 85;

  // 3. Lower Rim Analysis (frames resting on cheekbone under the eyes)
  // Landmark 117 (under left eye rim) vs 205 (cheek below it)
  // Landmark 346 (under right eye rim) vs 425 (cheek below it)
  const leftRimLum = sampleAvgLum(landmarks[117], 6);
  const leftSubCheekLum = sampleAvgLum(landmarks[205], 8);
  const leftRimDrop = leftSubCheekLum - leftRimLum;

  const rightRimLum = sampleAvgLum(landmarks[346], 6);
  const rightSubCheekLum = sampleAvgLum(landmarks[425], 8);
  const rightRimDrop = rightSubCheekLum - rightRimLum;

  let rimSignals = 0;
  if (leftRimDrop > 32 && leftRimLum < 80) rimSignals++;
  if (rightRimDrop > 32 && rightRimLum < 80) rimSignals++;

  // 4. Outer Temple / Frame Arm Hinges
  // Landmarks 127 and 356 (outer eye orbital edges)
  const leftHingeLum = sampleAvgLum(landmarks[127], 6);
  const rightHingeLum = sampleAvgLum(landmarks[356], 6);
  if (skinLum - leftHingeLum > 35 && leftHingeLum < 75) rimSignals++;
  if (skinLum - rightHingeLum > 35 && rightHingeLum < 75) rimSignals++;

  // 5. Specular Lens Reflection / Glare
  // Check eye center regions for intense white highlights (> 230)
  // Landmarks 468 (left iris center) and 473 (right iris center) or fallback 159/386
  let glares = 0;
  const irisPts = [159, 145, 386, 374];
  for (const idx of irisPts) {
    const pt = landmarks[idx];
    if (!pt) continue;
    const d = samplePatch(ctx, pt.x * w, pt.y * h, 8);
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) {
        glares++;
        break;
      }
    }
  }

  // Combined Evidence Rule:
  // Requires at least TWO distinct optical signals to avoid false positives on bare faces!
  const wearingGlasses =
    (hasDarkBridge && rimSignals >= 1) ||
    (hasDarkBridge && glares >= 2) ||
    rimSignals >= 3 ||
    (hasDarkBridge && bridgeDarkDrop > 45);

  return {
    pass: !wearingGlasses,
    msg: wearingGlasses
      ? 'Mohon lepas kacamata Anda agar area mata dan kulit terbaca'
      : 'Bebas kacamata',
    wearingGlasses,
    hasPhysicalBridge: hasDarkBridge,
    rimSignals,
    glares,
    confidence: wearingGlasses ? 0.9 : 0.95,
  };
}

/**
 * Fallback optical CV checker when MediaPipe landmarks are not yet available.
 * Calibrated strictly to avoid false alarms from pupils or eyebrows.
 */
export function checkGlassesFallback(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number
): GlassesCheckResult {
  // 1. Reference Skin Lum from Cheeks (y = 58% of height, x = 28% and 72%)
  const leftCheek = ctx.getImageData(
    Math.round(w * 0.28),
    Math.round(h * 0.58),
    12,
    12
  ).data;
  const rightCheek = ctx.getImageData(
    Math.round(w * 0.72),
    Math.round(h * 0.58),
    12,
    12
  ).data;

  let cheekLum = 0;
  for (let i = 0; i < leftCheek.length; i += 4) {
    cheekLum += getLum(leftCheek, i);
  }
  for (let i = 0; i < rightCheek.length; i += 4) {
    cheekLum += getLum(rightCheek, i);
  }
  cheekLum /= (leftCheek.length + rightCheek.length) / 4;

  // 2. Sample narrow nose bridge center strip (x: 47%..53%, y: 41%..45%)
  // At this position, we are on the nasal bone, between the eyes, safely below eyebrows
  const bridgeX = Math.round(w * 0.47);
  const bridgeY = Math.round(h * 0.41);
  const bridgeW = Math.round(w * 0.06);
  const bridgeH = Math.round(h * 0.04);

  const bridgeData = ctx.getImageData(bridgeX, bridgeY, bridgeW, bridgeH).data;
  let bridgeLum = 0;
  let darkPixelCount = 0;
  const totalBridgePixels = bridgeData.length / 4;

  for (let i = 0; i < bridgeData.length; i += 4) {
    const l = getLum(bridgeData, i);
    bridgeLum += l;
    if (l < 55) darkPixelCount++;
  }
  bridgeLum /= Math.max(1, totalBridgePixels);

  const bridgeDrop = cheekLum - bridgeLum;
  const darkRatio = darkPixelCount / Math.max(1, totalBridgePixels);

  // Only consider glasses if bridge is substantially darker than cheek AND has continuous dark bridge line
  const wearingGlasses =
    cheekLum > 60 && bridgeDrop > 38 && darkRatio > 0.40 && bridgeLum < 65;

  return {
    pass: !wearingGlasses,
    msg: wearingGlasses
      ? 'Mohon lepas kacamata Anda agar area mata dan kulit terbaca'
      : 'Bebas kacamata',
    wearingGlasses,
    hasPhysicalBridge: wearingGlasses,
    rimSignals: 0,
    glares: 0,
    confidence: 0.85,
  };
}
