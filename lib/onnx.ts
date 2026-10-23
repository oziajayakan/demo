// lib/onnx.ts
// ONNX Runtime Web Inference Pipeline for skin_model.onnx

export interface PredictionResult {
  skinType: {
    type: string;
    label: string;
    probability: number;
    allTypes: { type: string; label: string; prob: number }[];
  };
  concerns: {
    code: string;
    label: string;
    prob: number;
    active: boolean;
    threshold: number;
  }[];
  confidence: number;
}

let sessionInstance: any = null;
let labelsSpec: any = null;

export async function getLabelsSpec() {
  if (labelsSpec) return labelsSpec;
  try {
    const res = await fetch('/models/labels.json');
    if (res.ok) {
      labelsSpec = await res.json();
      return labelsSpec;
    }
  } catch (err) {
    console.warn('Failed to fetch /models/labels.json, using fallback:', err);
  }

  // Fallback spec matching ml/out/labels.json
  labelsSpec = {
    type_classes: ['berminyak', 'kering', 'normal', 'kombinasi'],
    concern_classes: ['jerawat', 'flek_hitam', 'kemerahan', 'pori_besar', 'kerutan'],
    display: {
      berminyak: 'Berminyak',
      kering: 'Kering',
      normal: 'Normal',
      kombinasi: 'Kombinasi',
      jerawat: 'Berjerawat',
      flek_hitam: 'Flek Hitam & Bekas Jerawat',
      kemerahan: 'Kemerahan',
      pori_besar: 'Pori-pori Besar',
      kerutan: 'Garis Halus & Penuaan',
    },
    input_size: 224,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    concern_thresholds: {
      jerawat: 0.35,
      flek_hitam: 0.65,
      kemerahan: 0.45,
      pori_besar: 0.55,
      kerutan: 0.35,
    },
    min_confidence: 0.45,
  };
  return labelsSpec;
}

/**
 * Initializes ONNX Runtime Web session
 */
export async function initOnnxSession() {
  if (sessionInstance) return sessionInstance;
  const ort = (window as any).ort;
  if (!ort) {
    throw new Error('ONNX Runtime Web library not loaded in window.ort');
  }

  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;

  try {
    sessionInstance = await ort.InferenceSession.create('/models/skin_model.onnx', {
      executionProviders: ['wasm'],
    });
    console.log('ONNX Model Loaded Successfully!');
    return sessionInstance;
  } catch (err) {
    console.error('Failed to load ONNX model via local path:', err);
    throw err;
  }
}

/**
 * Prepares image tensor from an HTMLCanvasElement (RGB 224x224 normalized)
 */
export function preprocessCanvasToTensor(
  canvas: HTMLCanvasElement,
  spec: any
): any {
  const ort = (window as any).ort;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D context not available');

  const imgData = ctx.getImageData(0, 0, 224, 224).data;
  const size = 224 * 224;
  const floatData = new Float32Array(3 * size);

  const mean = spec.mean || [0.485, 0.456, 0.406];
  const std = spec.std || [0.229, 0.224, 0.225];

  for (let i = 0; i < size; i++) {
    const idx = i * 4;
    // NCHW layout: [R... G... B...]
    floatData[i] = (imgData[idx] / 255.0 - mean[0]) / std[0];
    floatData[size + i] = (imgData[idx + 1] / 255.0 - mean[1]) / std[1];
    floatData[2 * size + i] = (imgData[idx + 2] / 255.0 - mean[2]) / std[2];
  }

  return new ort.Tensor('float32', floatData, [1, 3, 224, 224]);
}

/**
 * Runs ONNX inference on canvas crop
 */
export async function runSkinInference(
  canvas: HTMLCanvasElement
): Promise<PredictionResult> {
  const spec = await getLabelsSpec();
  const session = await initOnnxSession();
  const tensor = preprocessCanvasToTensor(canvas, spec);

  const feeds = { input: tensor };
  const results = await session.run(feeds);

  const typeProbsData = Array.from(results.type_probs?.data as Float32Array);
  const concernProbsData = Array.from(results.concern_probs?.data as Float32Array);

  // Dispose tensors to prevent memory leak
  tensor.dispose?.();
  results.type_probs?.dispose?.();
  results.concern_probs?.dispose?.();

  // Process skin types
  const typeClasses: string[] = spec.type_classes;
  const allTypes = typeClasses.map((t, idx) => ({
    type: t,
    label: spec.display[t] || t,
    prob: typeProbsData[idx] || 0,
  }));
  allTypes.sort((a, b) => b.prob - a.prob);

  const dominantType = {
    type: allTypes[0].type,
    label: allTypes[0].label,
    probability: allTypes[0].prob,
    allTypes,
  };

  // Confidence margin calculation
  const margin = dominantType.probability - (allTypes[1]?.prob || 0);
  let confidence = Math.round(dominantType.probability * 60 + margin * 40);
  confidence = Math.max(50, Math.min(98, confidence));

  // Process concerns
  const concernClasses: string[] = spec.concern_classes;
  const concerns = concernClasses.map((c, idx) => {
    const prob = concernProbsData[idx] || 0;
    const threshold = spec.concern_thresholds?.[c] ?? 0.45;
    return {
      code: c,
      label: spec.display[c] || c,
      prob: Math.round(prob * 100) / 100,
      active: prob >= threshold,
      threshold,
    };
  });

  return {
    skinType: dominantType,
    concerns,
    confidence,
  };
}
