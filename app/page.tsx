// app/page.tsx
'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  ShieldCheck,
  Zap,
  RefreshCw,
  Camera,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  Sun,
  UserCheck,
  Eye,
  Check,
  ArrowRight,
} from 'lucide-react';
import { runSkinInference, PredictionResult } from '@/lib/onnx';
import {
  sampleSkinRGB,
  computeLaplacianVariance,
  evaluateFlashChromaticity,
  LivenessResult,
} from '@/lib/flash-liveness';
import {
  checkGlassesWithLandmarks,
  checkGlassesFallback,
} from '@/lib/glasses-detector';
import { matchProducts, MatchedProduct, Product } from '@/lib/recommendations';

type ScanState =
  | 'IDLE'
  | 'CHECKING'
  | 'READY'
  | 'COUNTDOWN'
  | 'FLASH'
  | 'SCANNING'
  | 'SUCCESS'
  | 'FAILED'
  | 'ERROR';

export default function DemoAISkinScanner() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<any>(null);
  const landmarkerRef = useRef<any>(null);

  // Offscreen canvases
  const probeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cropCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Challenge session state from Edge API
  const [sessionData, setSessionData] = useState<any>(null);
  const [flashColor, setFlashColor] = useState('#00F0FF');
  const [isFlashing, setIsFlashing] = useState(false);

  // Scan state
  const [scanState, setScanState] = useState<ScanState>('IDLE');
  const [statusText, setStatusText] = useState('Posisikan wajah Anda tepat di dalam bingkai oval');
  const [countdownNum, setCountdownNum] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  // 4 Validasi Kualitas Kamera & Biometrik
  const [checks, setChecks] = useState({
    light: 'Memeriksa' as 'Menunggu' | 'Memeriksa' | 'Lolos',
    facePos: 'Memeriksa' as 'Menunggu' | 'Memeriksa' | 'Lolos',
    lookStraight: 'Memeriksa' as 'Menunggu' | 'Memeriksa' | 'Lolos',
    noGlasses: true,
  });

  // Results state
  const [predictionData, setPredictionData] = useState<PredictionResult | null>(null);
  const [recommendedProducts, setRecommendedProducts] = useState<MatchedProduct[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<string | null>(null);

  // 1. Fetch Challenge Session Nonce
  const fetchChallenge = useCallback(async () => {
    try {
      const res = await fetch('/api/session/challenge');
      if (!res.ok) throw new Error('Gagal mendapatkan challenge session');
      const data = await res.json();
      setSessionData(data);
      setFlashColor(data.challenge?.flashColor || '#00F0FF');
      return data;
    } catch (err: any) {
      console.warn('Using local challenge fallback:', err);
      const fallback = {
        sessionId: 'local-' + Date.now(),
        nonce: Math.random().toString(36).substring(2),
        issuedAt: Math.floor(Date.now() / 1000),
        challenge: { flashColor: '#00F0FF' },
      };
      setSessionData(fallback);
      return fallback;
    }
  }, []);

  // 2. Start Video Camera
  const startCamera = useCallback(async () => {
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
        audio: false,
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true;
        await videoRef.current.play();
      }
      setScanState('CHECKING');
      setStatusText('Posisikan wajah Anda tepat di dalam bingkai oval');
    } catch (err: any) {
      console.error('Camera access error:', err);
      setStatusText(
        err.name === 'NotAllowedError'
          ? 'Izin kamera ditolak. Berikan izin di browser Anda.'
          : 'Kamera tidak dapat diakses.'
      );
      setScanState('ERROR');
      setErrorMessage('Izin kamera diperlukan untuk auto-scan.');
    }
  }, []);

  // 3. Initialize MediaPipe FaceLandmarker
  useEffect(() => {
    let active = true;
    async function loadLandmarker() {
      try {
        const { FaceLandmarker, FilesetResolver } = await import(
          '@mediapipe/tasks-vision'
        );
        const fileset = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
        );
        const lm = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath:
              'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numFaces: 1,
        });
        if (active) landmarkerRef.current = lm;
      } catch {
        try {
          const { FaceLandmarker, FilesetResolver } = await import(
            '@mediapipe/tasks-vision'
          );
          const fileset = await FilesetResolver.forVisionTasks(
            'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
          );
          const lm = await FaceLandmarker.createFromOptions(fileset, {
            baseOptions: {
              modelAssetPath:
                'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
              delegate: 'CPU',
            },
            runningMode: 'VIDEO',
            numFaces: 1,
          });
          if (active) landmarkerRef.current = lm;
        } catch {
          console.warn('FaceLandmarker using optical CV fallback');
        }
      }
    }

    loadLandmarker();
    fetchChallenge();
    startCamera();

    return () => {
      active = false;
      clearInterval(timerRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, [fetchChallenge, startCamera]);

  // 4. Frame Quality & Positioning Checks (100ms Interval)
  useEffect(() => {
    if (scanState === 'SUCCESS' || scanState === 'ERROR') return;

    const checkFrame = () => {
      const video = videoRef.current;
      const pCanvas = probeCanvasRef.current;
      if (!video || !pCanvas || video.readyState < 2) return;

      pCanvas.width = 320;
      pCanvas.height = 240;
      const pCtx = pCanvas.getContext('2d', { willReadFrequently: true });
      if (!pCtx) return;

      pCtx.drawImage(video, 0, 0, 320, 240);

      // 1. Luminance
      const centerX = 320 * 0.25;
      const centerY = 240 * 0.2;
      const centerW = 320 * 0.5;
      const centerH = 240 * 0.6;
      const imgData = pCtx.getImageData(centerX, centerY, centerW, centerH).data;

      let totalLuma = 0;
      for (let i = 0; i < imgData.length; i += 4) {
        totalLuma +=
          0.299 * imgData[i] + 0.587 * imgData[i + 1] + 0.114 * imgData[i + 2];
      }
      const avgLuma = totalLuma / (imgData.length / 4);
      const isLightOk = avgLuma >= 45 && avgLuma <= 235;

      // 2. Face Position & Alignment
      let isPosOk = false;
      let isStraightOk = false;
      let isNoGlassesOk = true;

      if (landmarkerRef.current) {
        try {
          const lmRes = landmarkerRef.current.detectForVideo(
            video,
            performance.now()
          );
          if (lmRes?.faceLandmarks?.[0]) {
            const lm = lmRes.faceLandmarks[0];
            const chin = lm[152];
            const topForehead = lm[10];
            const leftCheek = lm[234];
            const rightCheek = lm[454];
            const noseTip = lm[1];
            const leftEye = lm[33];
            const rightEye = lm[263];

            const faceH = Math.abs(chin.y - topForehead.y);
            const cx = (leftCheek.x + rightCheek.x) / 2;
            const cy = (topForehead.y + chin.y) / 2;

            isPosOk =
              cx >= 0.28 && cx <= 0.72 && cy >= 0.20 && cy <= 0.75 && faceH >= 0.26;

            const leftDist = Math.abs(noseTip.x - leftCheek.x);
            const rightDist = Math.abs(rightCheek.x - noseTip.x);
            const yawRatio = leftDist / (rightDist || 0.001);
            const isYawOk = yawRatio >= 0.55 && yawRatio <= 1.80;
            const tilt = Math.abs(leftEye.y - rightEye.y);
            isStraightOk = isYawOk && tilt < 0.10;

            const glassesRes = checkGlassesWithLandmarks(lm, pCtx, 320, 240);
            isNoGlassesOk = glassesRes.pass;
          } else {
            isPosOk = avgLuma > 45;
            isStraightOk = isPosOk;
            const fallbackGlasses = checkGlassesFallback(pCtx, 320, 240);
            isNoGlassesOk = fallbackGlasses.pass;
          }
        } catch {
          isPosOk = avgLuma > 45;
          isStraightOk = isPosOk;
          const fallbackGlasses = checkGlassesFallback(pCtx, 320, 240);
          isNoGlassesOk = fallbackGlasses.pass;
        }
      } else {
        isPosOk = avgLuma > 45;
        isStraightOk = isPosOk;
        const fallbackGlasses = checkGlassesFallback(pCtx, 320, 240);
        isNoGlassesOk = fallbackGlasses.pass;
      }

      setChecks({
        light: isLightOk ? 'Lolos' : 'Memeriksa',
        facePos: isPosOk ? 'Lolos' : 'Memeriksa',
        lookStraight: isStraightOk ? 'Lolos' : 'Memeriksa',
        noGlasses: isNoGlassesOk,
      });

      const allReady = isLightOk && isPosOk && isStraightOk && isNoGlassesOk;

      if (!isNoGlassesOk) {
        setStatusText('Mohon lepas kacamata untuk ketepatan pemindaian kulit');
      } else if (!isLightOk) {
        setStatusText(
          avgLuma < 45
            ? 'Pencahayaan kurang, hadapkan wajah ke sumber cahaya'
            : 'Pencahayaan terlalu silau'
        );
      } else if (!isPosOk) {
        setStatusText('Posisikan wajah Anda tepat di dalam bingkai oval');
      } else if (!isStraightOk) {
        setStatusText('Arahkan pandangan lurus dan tegak ke arah kamera');
      } else {
        setStatusText('Posisi optimal terkalibrasi. Siap memindai...');
      }

      if (allReady && scanState !== 'READY' && scanState !== 'COUNTDOWN' && scanState !== 'FLASH' && scanState !== 'SCANNING') {
        setScanState('READY');
      } else if (!allReady && scanState === 'READY') {
        setScanState('CHECKING');
      }
    };

    timerRef.current = setInterval(checkFrame, 100);
    return () => clearInterval(timerRef.current);
  }, [scanState]);

  // 5. Countdown & Dynamic Screen Flash Liveness Trigger
  const handleStartScan = async () => {
    if (scanState === 'COUNTDOWN' || scanState === 'SCANNING') return;
    setScanState('COUNTDOWN');
    setStatusText('Tahan posisi stabil. Memulai verifikasi anti-layar...');

    // 3.. 2.. 1.. Countdown
    for (let n = 3; n > 0; n--) {
      setCountdownNum(n);
      await new Promise((r) => setTimeout(r, 700));
    }
    setCountdownNum(null);

    // Dynamic Flash Screen Challenge
    setScanState('FLASH');
    setIsFlashing(true);

    const video = videoRef.current;
    const pCanvas = probeCanvasRef.current;
    let liveness: LivenessResult | null = null;

    if (video && pCanvas) {
      pCanvas.width = 320;
      pCanvas.height = 240;
      const pCtx = pCanvas.getContext('2d', { willReadFrequently: true });
      if (pCtx) {
        pCtx.drawImage(video, 0, 0, 320, 240);
        const preRGB = sampleSkinRGB(pCtx, { x: 80, y: 60, w: 160, h: 120 });

        await new Promise((r) => setTimeout(r, 160));
        pCtx.drawImage(video, 0, 0, 320, 240);
        const flashRGB = sampleSkinRGB(pCtx, { x: 80, y: 60, w: 160, h: 120 });
        const laplacianVar = computeLaplacianVariance(pCtx, 320, 240);

        setIsFlashing(false);

        const targetColor = sessionData?.challenge?.flashColor || flashColor;
        liveness = evaluateFlashChromaticity(
          preRGB,
          flashRGB,
          targetColor,
          laplacianVar
        );
      }
    } else {
      setIsFlashing(false);
    }

    // Jika terdeteksi foto layar HP / gambar tidak menyerap kilatan flash biologis
    if (liveness && !liveness.passed) {
      setScanState('FAILED');
      setStatusText('Verifikasi gagal: terdeteksi layar perangkat lain atau foto');
      setErrorMessage(
        'Sistem mendeteksi kemungkinan foto cetak atau layar HP lain. Harap hadapkan wajah asli Anda langsung ke kamera.'
      );
      return;
    }

    // Eksekusi inferensi AI
    await executeInference(liveness);
  };

  // 6. Execute ONNX Multi-Head Inference & Match Products
  const executeInference = async (liveness: any) => {
    setScanState('SCANNING');
    setStatusText('Menganalisis tipe kulit & masalah kulit...');

    const video = videoRef.current;
    const cCanvas = cropCanvasRef.current;
    if (!video || !cCanvas) return;

    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;
    cCanvas.width = 224;
    cCanvas.height = 224;
    const cCtx = cCanvas.getContext('2d', { willReadFrequently: true });
    if (!cCtx) return;

    const side = Math.min(vw, vh);
    const sx = (vw - side) / 2;
    const sy = (vh - side) / 2;
    cCtx.drawImage(video, sx, sy, side, side, 0, 0, 224, 224);

    try {
      const prediction: PredictionResult = await runSkinInference(cCanvas);
      setPredictionData(prediction);

      // Load products & match based on prediction
      let productsJson: Product[] = [];
      try {
        const prodRes = await fetch('/products.json');
        if (prodRes.ok) productsJson = await prodRes.json();
      } catch (e) {
        console.warn('Failed loading /products.json', e);
      }

      // Convert active concerns to record
      const concernMap: Record<string, number> = {};
      prediction.concerns.forEach((c) => {
        if (c.active || c.prob >= 0.20) {
          concernMap[c.code] = c.prob;
        }
      });

      const matched = matchProducts(productsJson, prediction.skinType.type, concernMap);
      setRecommendedProducts(matched);

      setScanState('SUCCESS');
      setStatusText('Analisis kulit selesai.');

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    } catch (err: any) {
      console.error(err);
      setScanState('ERROR');
      setErrorMessage(err.message || 'Gagal memproses model analisis kulit');
    }
  };

  // Reset scan
  const handleResetScan = () => {
    setScanState('IDLE');
    setCountdownNum(null);
    setPredictionData(null);
    setRecommendedProducts([]);
    setSelectedProduct(null);
    setErrorMessage('');
    fetchChallenge();
    startCamera();
  };

  const allReady =
    checks.light === 'Lolos' &&
    checks.facePos === 'Lolos' &&
    checks.lookStraight === 'Lolos' &&
    checks.noGlasses;

  return (
    <div className="min-h-screen bg-[#14091a] text-[#f8eefb] font-sans relative overflow-x-hidden p-6 md:p-8 flex flex-col items-center">
      {/* Decorative Glowing Orbs */}
      <div className="fixed top-[-160px] left-[-140px] w-[500px] h-[500px] rounded-full bg-[#8e2f94] opacity-40 blur-[130px] pointer-events-none" />
      <div className="fixed bottom-[-180px] right-[-120px] w-[500px] h-[500px] rounded-full bg-[#4b2a9a] opacity-40 blur-[130px] pointer-events-none" />

      {/* Screen Flash Overlay during Active Challenge */}
      {isFlashing && (
        <div
          className="fixed inset-0 z-50 pointer-events-none transition-opacity duration-150"
          style={{
            backgroundColor: flashColor,
            opacity: 0.85,
          }}
        />
      )}

      {/* Offscreen canvases for probe & crop */}
      <canvas ref={probeCanvasRef} className="hidden" />
      <canvas ref={cropCanvasRef} className="hidden" />

      <main className="w-full max-w-[1120px] relative z-10 flex flex-col gap-6">
        {/* Header Bersih & Minimal */}
        <header className="text-center pt-2">
          <span className="inline-flex items-center gap-2 text-xs font-semibold tracking-widest uppercase text-[#f0b6ff] px-4 py-1.5 rounded-full border border-[rgba(255,255,255,0.14)] bg-[rgba(255,255,255,0.06)] backdrop-blur-md">
            <span className="w-2 h-2 rounded-full bg-[#4ade80] shadow-[0_0_8px_#4ade80] animate-pulse" />
            AI Auto-Scan Liveness
          </span>
          <div className="font-serif text-5xl md:text-6xl font-bold tracking-wider mt-2.5 bg-gradient-to-r from-white via-[#f0b6ff] to-[#c26bd0] bg-clip-text text-transparent">
            DEMO AI
          </div>
          <h1 className="text-xs md:text-sm font-normal tracking-[4px] uppercase text-[#f0b6ff] mt-1">
            Skin Analysis &amp; Recommendation
          </h1>
        </header>

        {/* 2-Column Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start mt-2">
          {/* Kolom Kiri: Kamera Scanner */}
          <section className="lg:col-span-6 flex flex-col bg-[rgba(255,255,255,0.06)] border border-[rgba(255,255,255,0.14)] rounded-[26px] p-5 backdrop-blur-[22px] shadow-[0_30px_60px_rgba(0,0,0,0.4)]">
            <div className="relative w-full aspect-[4/3] max-h-[380px] rounded-2xl overflow-hidden bg-[radial-gradient(circle_at_50%_40%,#35163f,#100617)] border border-[rgba(255,255,255,0.14)] flex items-center justify-center">
              {/* Live Video Feed */}
              <video
                ref={videoRef}
                playsInline
                muted
                autoPlay
                className={`absolute inset-0 w-full h-full object-cover -scale-x-100 ${
                  scanState === 'SUCCESS' ? 'hidden' : 'block'
                }`}
              />

              {/* Guide Oval & Precision Reticle */}
              {scanState !== 'SUCCESS' && (
                <svg
                  viewBox="0 0 400 300"
                  className="absolute inset-0 w-full h-full pointer-events-none z-10"
                  preserveAspectRatio="none"
                >
                  <ellipse
                    cx="200"
                    cy="150"
                    rx="90"
                    ry="120"
                    fill="none"
                    stroke={allReady ? '#4ADE80' : 'rgba(255, 255, 255, 0.55)'}
                    strokeWidth={allReady ? '3' : '2.5'}
                    strokeDasharray={allReady ? 'none' : '8 8'}
                    style={{
                      filter: allReady
                        ? 'drop-shadow(0 0 10px rgba(74, 222, 128, 0.75))'
                        : 'none',
                      transition: 'all 0.25s ease',
                    }}
                  />
                </svg>
              )}

              {/* Countdown Numbers 3.. 2.. 1.. */}
              {scanState === 'COUNTDOWN' && countdownNum !== null && (
                <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-pulse">
                  <span className="font-serif text-8xl font-bold text-white drop-shadow-[0_0_24px_rgba(240,182,255,0.8)]">
                    {countdownNum}
                  </span>
                </div>
              )}

              {/* Scanning Laser Beam Effect */}
              {scanState === 'SCANNING' && (
                <div className="absolute inset-x-0 h-1 bg-gradient-to-r from-transparent via-[#5eead4] to-transparent shadow-[0_0_16px_#5eead4] z-20 animate-pulse top-1/2" />
              )}

              {/* Dynamic Hint Pill at Viewport Bottom */}
              {scanState !== 'SUCCESS' && (
                <div
                  className={`absolute bottom-3.5 left-1/2 -translate-x-1/2 z-20 px-4 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap shadow-lg transition-all ${
                    allReady
                      ? 'bg-emerald-600/90 text-white border border-emerald-400'
                      : 'bg-[#100716]/90 text-[#f8eefb] border border-[rgba(255,255,255,0.14)]'
                  }`}
                >
                  {statusText}
                </div>
              )}
            </div>

            {/* Alert Banner Penolakan Layar HP / Foto */}
            {(scanState === 'FAILED' || scanState === 'ERROR') && (
              <div className="mt-3.5 p-3.5 rounded-xl bg-[rgba(251,113,133,0.15)] border border-[rgba(251,113,133,0.45)] text-[#fecdd3] text-xs leading-relaxed animate-in fade-in">
                <b className="text-white flex items-center gap-1.5 text-sm mb-1">
                  <AlertCircle className="w-4 h-4 text-[#fb7185]" />
                  {scanState === 'FAILED' ? 'Pindaian Ditolak' : 'Kendala Kamera'}
                </b>
                <span>{errorMessage || statusText}</span>
              </div>
            )}

            {/* 4 Sensor Kualitas / Biometrik Checks */}
            {scanState !== 'SUCCESS' && (
              <div className="grid grid-cols-4 gap-2 mt-3.5">
                <div className="bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] rounded-xl p-2 text-center">
                  <span className="text-[10px] text-[#bca1c6] block">Cahaya</span>
                  <span
                    className={`text-xs font-bold mt-0.5 block ${
                      checks.light === 'Lolos' ? 'text-[#4ade80]' : 'text-[#fbbf24]'
                    }`}
                  >
                    {checks.light}
                  </span>
                </div>
                <div className="bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] rounded-xl p-2 text-center">
                  <span className="text-[10px] text-[#bca1c6] block">Posisi</span>
                  <span
                    className={`text-xs font-bold mt-0.5 block ${
                      checks.facePos === 'Lolos' ? 'text-[#4ade80]' : 'text-[#fbbf24]'
                    }`}
                  >
                    {checks.facePos}
                  </span>
                </div>
                <div className="bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] rounded-xl p-2 text-center">
                  <span className="text-[10px] text-[#bca1c6] block">Lurus</span>
                  <span
                    className={`text-xs font-bold mt-0.5 block ${
                      checks.lookStraight === 'Lolos' ? 'text-[#4ade80]' : 'text-[#fbbf24]'
                    }`}
                  >
                    {checks.lookStraight}
                  </span>
                </div>
                <div className="bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] rounded-xl p-2 text-center">
                  <span className="text-[10px] text-[#bca1c6] block">Kacamata</span>
                  <span
                    className={`text-xs font-bold mt-0.5 block ${
                      checks.noGlasses ? 'text-[#4ade80]' : 'text-[#fb7185]'
                    }`}
                  >
                    {checks.noGlasses ? 'Bebas' : 'Lepas'}
                  </span>
                </div>
              </div>
            )}

            {/* Action Buttons */}
            <div className="mt-4 flex flex-col gap-3">
              {scanState === 'IDLE' && (
                <button
                  type="button"
                  onClick={startCamera}
                  className="w-full py-3.5 px-6 rounded-2xl bg-gradient-to-r from-[#8e2f94] via-[#c26bd0] to-[#f0b6ff] text-white font-semibold text-sm shadow-[0_10px_24px_rgba(142,47,148,0.45)] hover:brightness-110 active:scale-[0.98] transition flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Camera className="w-4 h-4" />
                  Buka Kamera &amp; Mulai Auto-Scan
                </button>
              )}

              {(scanState === 'READY' || scanState === 'CHECKING') && (
                <button
                  type="button"
                  onClick={handleStartScan}
                  disabled={!allReady}
                  className={`w-full py-3.5 px-6 rounded-2xl font-semibold text-sm transition flex items-center justify-center gap-2 ${
                    allReady
                      ? 'bg-gradient-to-r from-[#10b981] to-[#059669] text-white shadow-[0_10px_24px_rgba(16,185,129,0.4)] hover:brightness-110 cursor-pointer active:scale-[0.98]'
                      : 'bg-white/10 text-white/40 cursor-not-allowed border border-white/10'
                  }`}
                >
                  <Zap className="w-4 h-4" />
                  {allReady ? 'Pindai Wajah Sekarang' : 'Posisikan Wajah Sesuai Oval'}
                </button>
              )}

              {(scanState === 'SUCCESS' || scanState === 'FAILED' || scanState === 'ERROR') && (
                <button
                  type="button"
                  onClick={handleResetScan}
                  className="w-full py-3 px-6 rounded-2xl bg-white/10 hover:bg-white/15 text-white font-semibold text-sm border border-white/15 transition flex items-center justify-center gap-2 cursor-pointer"
                >
                  <RefreshCw className="w-4 h-4" />
                  Pindai Ulang
                </button>
              )}
            </div>
          </section>

          {/* Kolom Kanan: Hasil Analisis & Rekomendasi Terfokus */}
          <section className="lg:col-span-6 flex flex-col bg-[rgba(255,255,255,0.06)] border border-[rgba(255,255,255,0.14)] rounded-[26px] p-6 backdrop-blur-[22px] shadow-[0_30px_60px_rgba(0,0,0,0.4)] min-h-[480px]">
            <h2 className="font-serif text-2xl font-semibold">Hasil Analisis &amp; Rekomendasi</h2>
            <p className="text-xs text-[#bca1c6] mt-0.5 mb-3">
              Tipe kulit, masalah kulit, dan produk yang paling sesuai.
            </p>

            {scanState !== 'SUCCESS' || !predictionData ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center py-14 text-[#bca1c6]">
                <div className="w-16 h-16 rounded-full bg-[rgba(194,107,208,0.16)] border border-dashed border-[#c26bd0] flex items-center justify-center text-3xl mb-3 animate-bounce">
                  🪞
                </div>
                <h3 className="text-white font-semibold text-base mb-1">Belum Ada Hasil</h3>
                <p className="text-xs max-w-[280px] leading-relaxed">
                  Posisikan wajah di dalam oval kamera untuk verifikasi biometrik dan auto-scan langsung.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-4 animate-in fade-in duration-300">
                {/* 1. Bar Probabilitas Tipe Kulit */}
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-widest text-[#f0b6ff] mb-2 flex items-center gap-2">
                    <span>Tipe Kulit</span>
                    <span className="flex-1 h-[1px] bg-gradient-to-r from-[rgba(255,255,255,0.14)] to-transparent" />
                  </div>
                  <div className="space-y-2">
                    {predictionData.skinType.allTypes.map((t, idx) => (
                      <div key={t.type} className="space-y-1">
                        <div className="flex justify-between text-xs">
                          <span className={idx === 0 ? 'font-bold text-white' : 'text-[#bca1c6]'}>
                            {t.label}
                          </span>
                          <span className={idx === 0 ? 'font-bold text-[#f0b6ff]' : 'text-[#bca1c6]'}>
                            {t.percentage}%
                          </span>
                        </div>
                        <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-700 ${
                              idx === 0
                                ? 'bg-gradient-to-r from-[#8e2f94] via-[#c26bd0] to-[#f0b6ff] shadow-[0_0_8px_rgba(194,107,208,0.5)]'
                                : 'bg-[#6d2a78]'
                            }`}
                            style={{ width: `${t.percentage}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 2. Tags Masalah Kulit Terdeteksi */}
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-widest text-[#f0b6ff] mb-2 flex items-center gap-2">
                    <span>Kondisi Kulit Terdeteksi</span>
                    <span className="flex-1 h-[1px] bg-gradient-to-r from-[rgba(255,255,255,0.14)] to-transparent" />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {predictionData.concerns.filter((c) => c.active || c.prob >= 0.22).length > 0 ? (
                      predictionData.concerns
                        .filter((c) => c.active || c.prob >= 0.22)
                        .map((c) => (
                          <span
                            key={c.code}
                            className="px-3 py-1 rounded-full text-xs font-medium bg-[rgba(194,107,208,0.16)] border border-[#c26bd0]/50 text-[#f0b6ff]"
                          >
                            {c.label} · {c.percentage}%
                          </span>
                        ))
                    ) : (
                      <span className="px-3 py-1 rounded-full text-xs font-medium bg-emerald-500/10 border border-emerald-500/40 text-emerald-400">
                        Kondisi kulit bersih / tidak ada masalah menonjol
                      </span>
                    )}
                  </div>
                </div>

                {/* 3. Rekomendasi Terfokus: HANYA PRODUK PALING SESUAI (TANPA BPOM) */}
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-widest text-[#f0b6ff] mb-2 flex items-center gap-2">
                    <span>Produk Paling Sesuai</span>
                    <span className="flex-1 h-[1px] bg-gradient-to-r from-[rgba(255,255,255,0.14)] to-transparent" />
                  </div>

                  {recommendedProducts.length > 0 ? (
                    <div className="space-y-3">
                      {/* Produk Utama #1 */}
                      {recommendedProducts.slice(0, 1).map((p) => (
                        <div
                          key={p.id}
                          className="relative border-2 border-[#c26bd0] rounded-2xl p-4 bg-gradient-to-br from-white/[0.09] to-[rgba(194,107,208,0.14)] shadow-[0_8px_24px_rgba(0,0,0,0.3),0_0_20px_rgba(194,107,208,0.2)]"
                        >
                          <span className="inline-block text-[10px] font-bold tracking-wider uppercase bg-gradient-to-r from-[#8e2f94] via-[#c26bd0] to-[#f0b6ff] text-white rounded-full px-2.5 py-0.5 mb-2">
                            Pilihan Paling Tepat
                          </span>
                          <h3 className="text-base font-bold text-white leading-snug">{p.nama}</h3>
                          <div className="text-xs text-[#f0b6ff] font-medium mt-0.5">{p.kat}</div>

                          <div className="text-xs text-[#e2d9e6] mt-2.5 leading-relaxed bg-black/25 p-2.5 rounded-xl border-l-2 border-[#c26bd0]">
                            {p.reasons?.length ? (
                              <span>
                                Diformulasikan khusus untuk mengatasi{' '}
                                <b className="text-white">{p.reasons.join(' serta ')}</b> pada tipe kulit{' '}
                                <b className="text-white">{predictionData.skinType.label.toLowerCase()}</b>.
                              </span>
                            ) : (
                              <span>
                                Formula perawatan esensial harian untuk menyeimbangkan kelembapan tipe kulit{' '}
                                <b className="text-white">{predictionData.skinType.label.toLowerCase()}</b>.
                              </span>
                            )}
                          </div>

                          <div className="flex justify-between items-center mt-3 pt-2.5 border-t border-white/10">
                            <span className="text-base font-bold text-white">
                              Rp {(p.harga || 85000).toLocaleString('id-ID')}
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedProduct(p.nama);
                                alert(`✅ Produk [${p.nama}] berhasil dipilih!`);
                              }}
                              className="px-4 py-1.5 rounded-lg bg-gradient-to-r from-[#8e2f94] via-[#c26bd0] to-[#f0b6ff] text-white text-xs font-semibold cursor-pointer hover:brightness-110 active:scale-95 transition"
                            >
                              Pilih Produk Ini
                            </button>
                          </div>
                        </div>
                      ))}

                      {/* Produk Pendukung #2 (Opsional jika ada) */}
                      {recommendedProducts.slice(1, 2).map((p) => (
                        <div
                          key={p.id}
                          className="border border-white/15 rounded-2xl p-3.5 bg-white/[0.04]"
                        >
                          <span className="inline-block text-[10px] font-bold tracking-wider uppercase bg-white/15 text-white rounded-full px-2 py-0.5 mb-1">
                            Produk Pendukung
                          </span>
                          <h4 className="text-sm font-semibold text-white">{p.nama}</h4>
                          <div className="text-xs text-[#bca1c6]">{p.kat}</div>
                          <div className="flex justify-between items-center mt-2 pt-2 border-t border-white/10">
                            <span className="text-sm font-semibold text-white">
                              Rp {(p.harga || 75000).toLocaleString('id-ID')}
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedProduct(p.nama);
                                alert(`✅ Produk [${p.nama}] berhasil dipilih!`);
                              }}
                              className="px-3 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-medium transition cursor-pointer"
                            >
                              Pilih Produk
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-[#bca1c6]">Memuat rekomendasi produk...</p>
                  )}
                </div>
              </div>
            )}
          </section>
        </div>

        {/* Footer */}
        <footer className="text-center text-xs text-[#bca1c6] pt-2">
          DEMO AI · Real-Time Liveness &amp; MobileNetV3 Deep Learning
        </footer>
      </main>
    </div>
  );
}
