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
    return checkGlassesFallback(ctx, w, h);
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
    (bridgeDarkDrop > 16 && maxBridgeEdge > 6.0) ||
    (maxBridgeSpan > 40 && maxBridgeEdge > 7.0) ||
    minBridgeLum < 75;

  // B. Infraorbital Rim Detection (Under-eye & Outer Eye Frames)
  // Landmarks: 111 & 340 (infraorbital), 226 & 446 (outer frame rims), 130 & 359
  const rimPoints = [111, 340, 226, 446, 130, 359];
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
      if (v < 75) pVeryDark++;
      if (i % 18 < 17) pEdge += Math.abs(v - getLum(pD, i * 4 + 4));
    }
    if (
      (pMax - pMin > 42 && pVeryDark >= 3) ||
      pVeryDark >= 6 ||
      pEdge / count > 8.5
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
      const isWhiteSpecular = r > 210 && g > 210 && b > 210;
      const isCoatingTint = g > 130 && g - r > 18 && b > 100;
      if (isWhiteSpecular || isCoatingTint) {
        glares++;
        break;
      }
    }
  }

  // Decision rule: Calibrated to catch prescription glasses reliably
  const wearingGlasses =
    hasPhysicalBridge ||
    rimSignals >= 1 ||
    glares >= 2 ||
    (bridgeDarkDrop > 14 && rimSignals >= 1) ||
    (bridgeDarkDrop > 14 && glares >= 1);

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
 * Optical CV checker scanning the full eye and nasal bridge band
 * Compares against cheeks and detects dark horizontal frames and rims
 */
export function checkGlassesFallback(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number
): GlassesCheckResult {
  // 1. Reference Skin Lum from Cheeks (not forehead, to avoid bangs/hair bias)
  const leftCheek = ctx.getImageData(
    Math.round(w * 0.25),
    Math.round(h * 0.54),
    20,
    20
  ).data;
  const rightCheek = ctx.getImageData(
    Math.round(w * 0.65),
    Math.round(h * 0.54),
    20,
    20
  ).data;

  let cheekLum = 0;
  for (let i = 0; i < leftCheek.length; i += 4) {
    cheekLum += getLum(leftCheek, i);
  }
  for (let i = 0; i < rightCheek.length; i += 4) {
    cheekLum += getLum(rightCheek, i);
  }
  cheekLum /= (leftCheek.length + rightCheek.length) / 4;

  // 2. Scan Vertical Eye & Bridge Band (from y = 35% to 48% of canvas height)
  const scanYStart = Math.round(h * 0.35);
  const scanHeight = Math.round(h * 0.14);
  const scanXStart = Math.round(w * 0.25);
  const scanWidth = Math.round(w * 0.5);

  const bandData = ctx.getImageData(
    scanXStart,
    scanYStart,
    scanWidth,
    scanHeight
  ).data;

  let darkFramePixels = 0;
  let specularGlares = 0;
  let bridgeMinLum = 255;
  let bridgeTotalLum = 0;
  let bridgePixelCount = 0;

  // Nasal Bridge column range in the center 16% of width
  const bridgeLocalXStart = Math.round(scanWidth * 0.42);
  const bridgeLocalXEnd = Math.round(scanWidth * 0.58);

  for (let y = 0; y < scanHeight; y++) {
    for (let x = 0; x < scanWidth; x++) {
      const idx = (y * scanWidth + x) * 4;
      const l = getLum(bandData, idx);
      const r = bandData[idx];
      const g = bandData[idx + 1];
      const b = bandData[idx + 2];

      // Dark frame pixel threshold (dark plastic or metal frames)
      if (l < 75) {
        darkFramePixels++;
      }

      // Specular reflection on lenses
      if (r > 215 && g > 215 && b > 215) {
        specularGlares++;
      }

      // Nasal bridge center column
      if (x >= bridgeLocalXStart && x <= bridgeLocalXEnd) {
        bridgeTotalLum += l;
        bridgePixelCount++;
        if (l < bridgeMinLum) bridgeMinLum = l;
      }
    }
  }

  const avgBridgeLum =
    bridgePixelCount > 0 ? bridgeTotalLum / bridgePixelCount : cheekLum;
  const bridgeDrop = cheekLum - avgBridgeLum;

  // Any dark horizontal bridge or significant frame pixel cluster
  const totalPixels = scanWidth * scanHeight;
  const darkRatio = darkFramePixels / (totalPixels || 1);

  const wearingGlasses =
    bridgeDrop > 18 ||
    bridgeMinLum < 65 ||
    darkRatio > 0.045 ||
    darkFramePixels > 35 ||
    (bridgeDrop > 12 && specularGlares > 10);

  return {
    pass: !wearingGlasses,
    msg: wearingGlasses
      ? 'Mohon lepas kacamata Anda agar area mata dan kulit terbaca'
      : 'Bebas kacamata',
    wearingGlasses,
    hasPhysicalBridge: bridgeDrop > 16,
    rimSignals: darkFramePixels > 30 ? 1 : 0,
    glares: specularGlares,
  };
}
