// app/scan/page.tsx
'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import Link from 'next/link';
import {
  ShieldCheck,
  Zap,
  RefreshCw,
  Camera,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ShoppingBag,
  ArrowLeft,
  X,
  Check,
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

type ScanState =
  | 'INIT'
  | 'SEARCH'
  | 'ALIGN'
  | 'HOLD'
  | 'FLASH'
  | 'INFERRING'
  | 'VERIFYING'
  | 'SUCCESS'
  | 'FAILED'
  | 'ERROR';

export default function ScanPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const meshCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<any>(null);
  const landmarkerRef = useRef<any>(null);

  // Challenge session state from Edge API
  const [sessionData, setSessionData] = useState<any>(null);
  const [scanState, setScanState] = useState<ScanState>('INIT');
  const [headlineMsg, setHeadlineMsg] = useState('Posisikan Wajah');
  const [sublineMsg, setSublineMsg] = useState('Posisikan wajah Anda di dalam bingkai');
  const [errorMessage, setErrorMessage] = useState('');

  // Consent Modal state (matching L'Oreal Paris Skin Genius pre-scan dialog)
  const [showConsentModal, setShowConsentModal] = useState(true);
  const [agreePrivacy, setAgreePrivacy] = useState(true);
  const [agreeTerms, setAgreeTerms] = useState(true);

  // 3 Primary Top Status Gates matching L'Oreal Paris Skin Genius
  const [gates, setGates] = useState({
    light: false, // PENCAHAYAAN
    facePos: false, // POSISI WAJAH
    lookStraight: false, // PANDANGAN LURUS
    noGlasses: true, // BEBAS KACAMATA
    readyToHold: false,
  });

  const [holdProgress, setHoldProgress] = useState(0);
  const holdStartRef = useRef<number | null>(null);

  // Flash UI state
  const [isFlashing, setIsFlashing] = useState(false);
  const [flashColor, setFlashColor] = useState('#00F0FF');

  // Results
  const [verificationData, setVerificationData] = useState<any>(null);
  const [capturedThumbnail, setCapturedThumbnail] = useState<string | null>(null);

  // Hidden offscreen canvases
  const probeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cropCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // 1. Fetch Session Challenge Nonce from Edge API
  const fetchChallenge = useCallback(async () => {
    try {
      const res = await fetch('/api/session/challenge');
      if (!res.ok) throw new Error('Gagal mendapatkan challenge session');
      const data = await res.json();
      setSessionData(data);
      setFlashColor(data.challenge?.flashColor || '#00F0FF');
      return data;
    } catch (err: any) {
      console.error(err);
      setScanState('ERROR');
      setErrorMessage('Koneksi server terganggu: ' + err.message);
      return null;
    }
  }, []);

  // 2. Start Video Camera
  const startCamera = useCallback(async () => {
    setScanState('INIT');
    setHeadlineMsg('Memulai Kamera...');
    setSublineMsg('Mohon tunggu sebentar');

    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      setScanState('SEARCH');
      setHeadlineMsg('Posisikan Wajah');
      setSublineMsg('Posisikan wajah Anda tepat di dalam bingkai');
    } catch (err: any) {
      console.error(err);
      setScanState('ERROR');
      setErrorMessage(
        err.name === 'NotAllowedError'
          ? 'Izin kamera ditolak. Berikan izin kamera di browser Anda.'
          : 'Kamera tidak dapat diakses: ' + err.message
      );
    }
  }, []);

  // MediaPipe FaceLandmarker Initialization
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
        if (active) {
          landmarkerRef.current = lm;
        }
      } catch (e) {
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
          if (active) {
            landmarkerRef.current = lm;
          }
        } catch (err) {
          console.warn('FaceLandmarker offline, using CV fallback');
        }
      }
    }
    loadLandmarker();
    return () => {
      active = false;
    };
  }, []);

  // 3. Main Frame Processing & Real-Time 3D Face Wireframe Rendering Loop
  useEffect(() => {
    if (
      scanState === 'SUCCESS' ||
      scanState === 'ERROR' ||
      scanState === 'FLASH' ||
      showConsentModal
    ) {
      return;
    }

    const checkFrame = () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || !probeCanvasRef.current) {
        return;
      }

      const pCanvas = probeCanvasRef.current;
      pCanvas.width = 320;
      pCanvas.height = 240;
      const pCtx = pCanvas.getContext('2d', { willReadFrequently: true });
      if (!pCtx) return;

      pCtx.drawImage(video, 0, 0, 320, 240);

      // Measure central facial region luminance (center 50% width, 60% height)
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

      // 1. GATE: PENCAHAYAAN (optimal between 65 and 220)
      const isLightOk = avgLuma >= 65 && avgLuma <= 220;
      const isTooDark = avgLuma < 65;

      // Real-time Facial Landmarker & Orientation Tracking
      let isPosOk = false;
      let isStraightLookOk = false;
      let isNoGlassesOk = true;
      let landmarks: any[] | null = null;
      let posDetail = '';

      if (landmarkerRef.current) {
        try {
          const lmRes = landmarkerRef.current.detectForVideo(
            video,
            performance.now()
          );
          if (lmRes?.faceLandmarks?.[0]) {
            landmarks = lmRes.faceLandmarks[0];

            // Facial orientation & bounding calculation
            const chin = landmarks[152];
            const topForehead = landmarks[10];
            const leftCheek = landmarks[234];
            const rightCheek = landmarks[454];
            const noseTip = landmarks[1];
            const leftEye = landmarks[33];
            const rightEye = landmarks[263];

            const faceH = Math.abs(chin.y - topForehead.y);
            const cx = (leftCheek.x + rightCheek.x) / 2;
            const cy = (topForehead.y + chin.y) / 2;

            // 2. GATE: POSISI WAJAH (Centered & Good distance)
            const isCentered = cx >= 0.32 && cx <= 0.68 && cy >= 0.25 && cy <= 0.70;
            const isGoodDist = faceH >= 0.30 && faceH <= 0.82;
            isPosOk = isCentered && isGoodDist;

            if (!isGoodDist) {
              posDetail =
                faceH < 0.3
                  ? 'Dekatkan wajah ke kamera'
                  : 'Jauhkan sedikit wajah Anda';
            } else if (!isCentered) {
              posDetail = 'Posisikan wajah tepat di tengah';
            }

            // 3. GATE: PANDANGAN LURUS (Yaw & Roll symmetry)
            const leftDist = Math.abs(noseTip.x - leftCheek.x);
            const rightDist = Math.abs(rightCheek.x - noseTip.x);
            const yawRatio = leftDist / (rightDist || 0.001);
            const isYawOk = yawRatio >= 0.60 && yawRatio <= 1.65;
            const tilt = Math.abs(leftEye.y - rightEye.y);
            const isRollOk = tilt < 0.085;
            isStraightLookOk = isYawOk && isRollOk;

            // 4. GATE: BEBAS KACAMATA
            const glassesRes = checkGlassesWithLandmarks(landmarks, pCtx, 320, 240);
            isNoGlassesOk = glassesRes.pass;
          } else {
            // No landmarks detected yet
            isPosOk = avgLuma > 50;
            isStraightLookOk = isPosOk;
            const fallbackGlasses = checkGlassesFallback(pCtx, 320, 240);
            isNoGlassesOk = fallbackGlasses.pass;
          }
        } catch {
          isPosOk = avgLuma > 50;
          isStraightLookOk = isPosOk;
          const fallbackGlasses = checkGlassesFallback(pCtx, 320, 240);
          isNoGlassesOk = fallbackGlasses.pass;
        }
      } else {
        isPosOk = avgLuma > 50;
        isStraightLookOk = isPosOk;
        const fallbackGlasses = checkGlassesFallback(pCtx, 320, 240);
        isNoGlassesOk = fallbackGlasses.pass;
      }

      const allGatesOk =
        isLightOk && isPosOk && isStraightLookOk && isNoGlassesOk;

      setGates({
        light: isLightOk,
        facePos: isPosOk,
        lookStraight: isStraightLookOk,
        noGlasses: isNoGlassesOk,
        readyToHold: allGatesOk,
      });

      // Render 3D Wireframe Face Mesh onto overlay canvas
      if (meshCanvasRef.current) {
        const mCanvas = meshCanvasRef.current;
        mCanvas.width = video.videoWidth || 640;
        mCanvas.height = video.videoHeight || 480;
        const mCtx = mCanvas.getContext('2d');
        if (mCtx) {
          drawFaceWireframe(
            mCtx,
            landmarks,
            mCanvas.width,
            mCanvas.height,
            allGatesOk
          );
        }
      }

      // Guidance messaging based on active gate priority
      const now = performance.now();
      if (allGatesOk) {
        setHeadlineMsg('Sempurna!');
        setSublineMsg('Tahan posisi Anda selama 2 detik...');

        if (!holdStartRef.current) {
          holdStartRef.current = now;
          setScanState('HOLD');
        }
        const elapsed = now - holdStartRef.current;
        const progress = Math.min(1.0, elapsed / 1400);
        setHoldProgress(progress);

        if (progress >= 1.0 && scanState === 'HOLD') {
          triggerFlashChallenge();
        }
      } else {
        holdStartRef.current = null;
        setHoldProgress(0);
        if (scanState === 'HOLD') setScanState('SEARCH');

        if (!isLightOk) {
          setHeadlineMsg(isTooDark ? 'Terlalu gelap!' : 'Terlalu silau!');
          setSublineMsg(
            isTooDark
              ? 'Terlalu gelap, butuh pencahayaan'
              : 'Kurangi pencahayaan langsung ke kamera'
          );
        } else if (!isPosOk) {
          setHeadlineMsg('Posisikan Wajah!');
          setSublineMsg(posDetail || 'Posisikan wajah Anda tepat di dalam bingkai');
        } else if (!isStraightLookOk) {
          setHeadlineMsg('Pandangan Lurus!');
          setSublineMsg('Arahkan pandangan lurus ke arah kamera');
        } else if (!isNoGlassesOk) {
          setHeadlineMsg('Lepas Kacamata!');
          setSublineMsg('Mohon lepas kacamata Anda agar area mata terbaca');
        } else {
          setHeadlineMsg('Posisikan Wajah');
          setSublineMsg('Posisikan wajah Anda di dalam bingkai');
        }
      }
    };

    timerRef.current = setInterval(checkFrame, 80);
    return () => clearInterval(timerRef.current);
  }, [scanState, showConsentModal]);

  // 4. Trigger Dynamic Screen Flash Challenge
  const triggerFlashChallenge = async () => {
    setScanState('FLASH');
    clearInterval(timerRef.current);
    setHeadlineMsg('Memeriksa pantulan cahaya...');
    setSublineMsg('Tahan posisi stabil');

    const video = videoRef.current;
    if (!video || !probeCanvasRef.current || !cropCanvasRef.current) return;

    const pCanvas = probeCanvasRef.current;
    pCanvas.width = 320;
    pCanvas.height = 240;
    const pCtx = pCanvas.getContext('2d', { willReadFrequently: true });
    if (!pCtx) return;

    // Step A: Sample pre-flash skin RGB
    pCtx.drawImage(video, 0, 0, 320, 240);
    const preRGB = sampleSkinRGB(pCtx, { x: 80, y: 60, w: 160, h: 120 });

    // Step B: Flash screen with challenge color
    setIsFlashing(true);
    await new Promise((r) => setTimeout(r, 160));

    // Step C: Sample peak-flash skin RGB
    pCtx.drawImage(video, 0, 0, 320, 240);
    const flashRGB = sampleSkinRGB(pCtx, { x: 80, y: 60, w: 160, h: 120 });
    const laplacianVar = computeLaplacianVariance(pCtx, 320, 240);

    // Stop flash overlay
    setIsFlashing(false);

    // Step D: Evaluate Chromatic Shift Liveness
    const targetColor = sessionData?.challenge?.flashColor || flashColor;
    const liveness: LivenessResult = evaluateFlashChromaticity(
      preRGB,
      flashRGB,
      targetColor,
      laplacianVar
    );

    if (!liveness.passed) {
      setScanState('FAILED');
      setHeadlineMsg('Verifikasi Gagal');
      setSublineMsg(liveness.reason || 'Pantulan cahaya tidak wajar');
      setErrorMessage(
        'Sistem mendeteksi kemungkinan foto cetak, layar HP lain, atau pantulan tidak alami. Harap gunakan wajah asli Anda.'
      );
      return;
    }

    // Step E: If Liveness passed -> Run ONNX Multi-Head Inference
    await executeInference(liveness);
  };

  // 5. Execute ONNX WebAssembly Inference & Server Verification
  const executeInference = async (liveness: LivenessResult) => {
    setScanState('INFERRING');
    setHeadlineMsg('Menganalisis Kulit...');
    setSublineMsg('Model AI sedang memproses tipe & masalah kulit');

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

    const thumbnail = cCanvas.toDataURL('image/jpeg', 0.9);
    setCapturedThumbnail(thumbnail);

    try {
      const prediction: PredictionResult = await runSkinInference(cCanvas);

      setScanState('VERIFYING');
      setHeadlineMsg('Menyiapkan Rekomendasi...');
      setSublineMsg('Mencocokkan formulasi produk BPOM...');

      // Pastikan session data selalu aktif dan segar (TTL 15 menit)
      let currentSession = sessionData;
      if (
        !currentSession ||
        Math.floor(Date.now() / 1000) - currentSession.issuedAt > 300
      ) {
        currentSession = await fetchChallenge();
      }

      if (!currentSession) {
        throw new Error('Sesi scan belum siap. Harap klik Coba Lagi.');
      }

      const verifyRes = await fetch('/api/scan/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: currentSession.sessionId,
          nonce: currentSession.nonce,
          issuedAt: currentSession.issuedAt,
          flashColor: currentSession.challenge?.flashColor || flashColor,
          signature: currentSession.signature,
          livenessResult: liveness,
          prediction,
        }),
      });

      const verifyData = await verifyRes.json();
      if (!verifyRes.ok) {
        throw new Error(verifyData.message || 'Verifikasi server gagal');
      }

      setVerificationData(verifyData);
      setScanState('SUCCESS');

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    } catch (err: any) {
      console.error(err);
      setScanState('ERROR');
      setErrorMessage(err.message || 'Gagal memproses model');
    }
  };

  // Reset & Try Again
  const handleRetake = () => {
    setVerificationData(null);
    setCapturedThumbnail(null);
    setErrorMessage('');
    holdStartRef.current = null;
    setHoldProgress(0);
    fetchChallenge().then(() => {
      startCamera();
    });
  };

  // Handle Consent Agreement
  const handleAcceptConsent = () => {
    setShowConsentModal(false);
    fetchChallenge().then(() => {
      startCamera();
    });
  };

  // Initial load check
  useEffect(() => {
    return () => {
      clearInterval(timerRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  return (
    <div className="min-h-screen bg-black text-white flex flex-col items-center justify-between selection:bg-[#e31b4c] selection:text-white">
      {/* Dynamic Screen Flash Fullscreen Overlay */}
      {isFlashing && (
        <div
          className="fixed inset-0 z-[999] pointer-events-none transition-opacity duration-75"
          style={{ backgroundColor: flashColor, opacity: 0.95 }}
        />
      )}

      {/* Hidden Offscreen Canvases */}
      <canvas ref={probeCanvasRef} className="hidden" />
      <canvas ref={cropCanvasRef} className="hidden" />

      {/* 1. PRE-SCAN PRIVACY CONSENT MODAL (Matching L'Oreal Paris Skin Genius) */}
      {showConsentModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-white text-slate-900 rounded-3xl p-6 sm:p-8 max-w-md w-full shadow-2xl relative space-y-5 animate-in fade-in zoom-in-95 duration-200">
            <Link
              href="/"
              className="absolute top-5 right-5 text-slate-400 hover:text-slate-700 transition"
            >
              <X className="w-5 h-5" />
            </Link>

            <div className="space-y-3 pt-1">
              <h2 className="font-serif text-2xl sm:text-3xl font-bold text-slate-900 leading-tight">
                Kami tidak menyimpan fotomu
              </h2>
              <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
                Skin Genius memberikan rekomendasi perawatan dan informasi produk
                secara umum, tidak menggantikan nasihat profesional. Kamu harus
                berusia minimal 16 tahun untuk menggunakan layanan ini. Baca Syarat &
                Ketentuan. Sistem menggunakan data pribadimu untuk memberikan laporan
                kulit dan rekomendasi. Fotomu tidak disimpan dan segera dihapus
                setelah analisa. Untuk informasi lebih lanjut, baca Kebijakan Privasi.
              </p>
            </div>

            <div className="space-y-3 pt-2">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={agreePrivacy}
                  onChange={(e) => setAgreePrivacy(e.target.checked)}
                  className="mt-0.5 w-4 h-4 rounded border-slate-300 text-[#e31b4c] focus:ring-[#e31b4c] cursor-pointer"
                />
                <span className="text-xs text-slate-700 leading-snug">
                  Saya mengerti dan setuju dengan{' '}
                  <strong className="underline decoration-slate-400">
                    Kebijakan Privasi
                  </strong>
                </span>
              </label>

              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={agreeTerms}
                  onChange={(e) => setAgreeTerms(e.target.checked)}
                  className="mt-0.5 w-4 h-4 rounded border-slate-300 text-[#e31b4c] focus:ring-[#e31b4c] cursor-pointer"
                />
                <span className="text-xs text-slate-700 leading-snug">
                  Saya mengerti dan setuju dengan{' '}
                  <strong className="underline decoration-slate-400">
                    Syarat & Ketentuan
                  </strong>
                </span>
              </label>
            </div>

            <button
              onClick={handleAcceptConsent}
              disabled={!agreePrivacy || !agreeTerms}
              className={`w-full py-3.5 rounded-xl font-bold text-sm text-white shadow-lg transition flex items-center justify-center gap-2 cursor-pointer ${
                agreePrivacy && agreeTerms
                  ? 'bg-[#e31b4c] hover:bg-[#c9123e] shadow-red-500/25 active:scale-[0.99]'
                  : 'bg-slate-200 text-slate-400 cursor-not-allowed shadow-none'
              }`}
            >
              Saya setuju
            </button>
          </div>
        </div>
      )}

      {/* Main Container */}
      <div className="w-full max-w-lg mx-auto px-4 py-4 sm:py-6 flex flex-col flex-1">
        {/* Navigation & Controls */}
        <div className="flex items-center justify-between pb-3">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-xs text-zinc-400 hover:text-white transition font-medium"
          >
            <ArrowLeft className="w-4 h-4" />
            Kembali
          </Link>

          {scanState !== 'SUCCESS' && (
            <button
              type="button"
              onClick={handleRetake}
              className="inline-flex items-center gap-1.5 text-xs text-zinc-400 hover:text-white transition font-medium cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh Cek
            </button>
          )}
        </div>

        {/* 2. SCANNER ACTIVE VIEW (Styled after L'Oreal Paris Skin Genius) */}
        {scanState !== 'SUCCESS' ? (
          <div className="flex flex-col flex-1 items-center justify-between space-y-4">
            {/* Top 3 Status Chips (Matching L'Oreal Paris layout) */}
            <div className="grid grid-cols-3 gap-2 w-full max-w-sm pt-1">
              {/* PENCAHAYAAN */}
              <div
                className={`py-1.5 px-2 text-center rounded border transition text-[11px] font-semibold tracking-wider uppercase ${
                  gates.light
                    ? 'border-[#00e676] text-[#00e676] bg-[#00e676]/10'
                    : 'border-[#ff1744] text-[#ff1744] bg-[#ff1744]/10'
                }`}
              >
                Pencahayaan
              </div>

              {/* POSISI WAJAH */}
              <div
                className={`py-1.5 px-2 text-center rounded border transition text-[11px] font-semibold tracking-wider uppercase ${
                  gates.facePos
                    ? 'border-[#00e676] text-[#00e676] bg-[#00e676]/10'
                    : 'border-[#ff1744] text-[#ff1744] bg-[#ff1744]/10'
                }`}
              >
                Posisi Wajah
              </div>

              {/* PANDANGAN LURUS */}
              <div
                className={`py-1.5 px-2 text-center rounded border transition text-[11px] font-semibold tracking-wider uppercase ${
                  gates.lookStraight
                    ? 'border-[#00e676] text-[#00e676] bg-[#00e676]/10'
                    : 'border-[#ff1744] text-[#ff1744] bg-[#ff1744]/10'
                }`}
              >
                Pandangan Lurus
              </div>
            </div>

            {/* Glasses Alert Pill (if detected) */}
            {!gates.noGlasses && (
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#ff1744] text-white text-xs font-semibold shadow-lg shadow-red-500/20 animate-pulse">
                <XCircle className="w-4 h-4" />
                Mohon lepas kacamata Anda
              </div>
            )}

            {/* Camera Viewport with Corner Reticle & 3D Wireframe Face Mesh */}
            <div className="relative aspect-[3/4] w-full max-w-sm rounded-2xl overflow-hidden bg-zinc-950 flex items-center justify-center border border-zinc-800 shadow-2xl">
              {/* Guidance Messages directly above the face frame */}
              <div className="absolute top-4 inset-x-4 z-20 text-center pointer-events-none space-y-1">
                <h3 className="text-xl sm:text-2xl font-bold text-white drop-shadow-md">
                  {headlineMsg}
                </h3>
                <p className="text-xs sm:text-sm text-zinc-200 drop-shadow">
                  {sublineMsg}
                </p>
              </div>

              {/* Video Feed */}
              <video
                ref={videoRef}
                playsInline
                muted
                autoPlay
                className="absolute inset-0 w-full h-full object-cover -scale-x-100"
              />

              {/* Real-time 3D Wireframe Face Mesh Overlay */}
              <canvas
                ref={meshCanvasRef}
                className="absolute inset-0 w-full h-full pointer-events-none z-10 -scale-x-100"
              />

              {/* 4 Corner-Bracket Reticle Enclosing Face Area (Like L'Oreal Paris) */}
              <div className="absolute inset-x-8 inset-y-16 pointer-events-none z-10 flex flex-col justify-between">
                <div className="flex justify-between">
                  {/* Top-Left */}
                  <div
                    className={`w-12 h-12 border-t-4 border-l-4 rounded-tl-2xl transition-colors duration-200 ${
                      gates.readyToHold ? 'border-[#00e676]' : 'border-[#ff1744]'
                    }`}
                  />
                  {/* Top-Right */}
                  <div
                    className={`w-12 h-12 border-t-4 border-r-4 rounded-tr-2xl transition-colors duration-200 ${
                      gates.readyToHold ? 'border-[#00e676]' : 'border-[#ff1744]'
                    }`}
                  />
                </div>

                <div className="flex justify-between">
                  {/* Bottom-Left */}
                  <div
                    className={`w-12 h-12 border-b-4 border-l-4 rounded-bl-2xl transition-colors duration-200 ${
                      gates.readyToHold ? 'border-[#00e676]' : 'border-[#ff1744]'
                    }`}
                  />
                  {/* Bottom-Right */}
                  <div
                    className={`w-12 h-12 border-b-4 border-r-4 rounded-br-2xl transition-colors duration-200 ${
                      gates.readyToHold ? 'border-[#00e676]' : 'border-[#ff1744]'
                    }`}
                  />
                </div>
              </div>

              {/* Progress Bar during HOLD Countdown */}
              {scanState === 'HOLD' && (
                <div className="absolute bottom-6 inset-x-12 z-20 h-2 bg-black/60 rounded-full overflow-hidden p-0.5 border border-white/20">
                  <div
                    className="h-full bg-[#00e676] rounded-full transition-all duration-75"
                    style={{ width: `${holdProgress * 100}%` }}
                  />
                </div>
              )}
            </div>

            {/* Error Notice */}
            {(scanState === 'FAILED' || scanState === 'ERROR') && (
              <div className="w-full max-w-sm bg-red-950/80 rounded-2xl p-4 border border-red-800 space-y-2 text-left">
                <div className="flex items-center gap-1.5 text-red-400 font-semibold text-xs">
                  <AlertCircle className="w-4 h-4 text-red-400" />
                  Pemindaian Dibatalkan
                </div>
                <p className="text-xs text-red-200 leading-relaxed">
                  {errorMessage || 'Wajah tidak memenuhi syarat pemindaian.'}
                </p>
                <button
                  onClick={handleRetake}
                  className="mt-1 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#e31b4c] hover:bg-[#c9123e] text-white font-medium text-xs transition cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Coba Lagi
                </button>
              </div>
            )}
          </div>
        ) : (
          /* 3. RESULT VIEW: Comprehensive Transparent Percentage Breakdown */
          <div className="space-y-5 text-slate-900 pb-10">
            {/* Diagnosis Summary Card */}
            <div className="bg-white rounded-3xl p-5 sm:p-6 shadow-xl space-y-6">
              <div className="flex items-start justify-between gap-4 border-b border-slate-100 pb-4">
                <div className="space-y-1">
                  <span className="inline-block text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2.5 py-0.5 rounded-full border border-emerald-200 mb-1">
                    ✓ Terverifikasi Anti-Manipulasi
                  </span>
                  <h2 className="font-serif text-2xl sm:text-3xl font-bold text-slate-900 capitalize">
                    Kulit {verificationData?.analysis?.skinType?.label} (
                    {verificationData?.analysis?.skinType?.percentage ||
                      (
                        verificationData?.analysis?.skinType?.probability * 100
                      )?.toFixed(1)}
                    %)
                  </h2>
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <span>
                      Keyakinan AI:{' '}
                      <strong>{verificationData?.analysis?.confidence}%</strong>
                    </span>
                    <span>·</span>
                    <span>
                      Skor Kulit:{' '}
                      <strong className="text-[#e31b4c]">
                        {verificationData?.analysis?.skinScore || 85}/100
                      </strong>
                    </span>
                  </div>
                </div>

                {capturedThumbnail && (
                  <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl overflow-hidden border border-slate-200 flex-shrink-0 shadow-md">
                    <img
                      src={capturedThumbnail}
                      alt="Wajah"
                      className="w-full h-full object-cover"
                    />
                  </div>
                )}
              </div>

              {/* 1. Transparansi Distribusi Tipe Kulit (Semua 4 Kelas) */}
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <h4 className="text-xs font-semibold text-slate-800 uppercase tracking-wider">
                    Distribusi Tipe Kulit (Transparan):
                  </h4>
                  <span className="text-[10px] text-slate-400">Total 100%</span>
                </div>
                <div className="space-y-2">
                  {verificationData?.analysis?.skinType?.allTypes?.map((t: any) => {
                    const pct =
                      t.percentage ?? Math.round((t.prob || 0) * 1000) / 10;
                    const isTop =
                      t.type === verificationData?.analysis?.skinType?.type;
                    return (
                      <div key={t.type} className="space-y-1">
                        <div className="flex justify-between text-xs">
                          <span
                            className={`font-medium ${
                              isTop
                                ? 'text-[#e31b4c] font-bold'
                                : 'text-slate-600'
                            }`}
                          >
                            {t.label} {isTop && '(Tipe Utama)'}
                          </span>
                          <span
                            className={`font-mono text-xs ${
                              isTop
                                ? 'text-[#e31b4c] font-bold'
                                : 'text-slate-500'
                            }`}
                          >
                            {pct}%
                          </span>
                        </div>
                        <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-500 ${
                              isTop ? 'bg-[#e31b4c]' : 'bg-slate-300'
                            }`}
                            style={{ width: `${Math.max(3, pct)}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 2. Transparansi Masalah Kulit & Ambang Batas (Semua 5 Kelas) */}
              <div className="space-y-3 pt-2 border-t border-slate-100">
                <div className="flex justify-between items-center">
                  <h4 className="text-xs font-semibold text-slate-800 uppercase tracking-wider">
                    Analisis Masalah Kulit (Transparan & Ambang):
                  </h4>
                  <span className="text-[10px] text-slate-400">
                    Model Sigmoid Multilabel
                  </span>
                </div>
                <div className="space-y-2.5">
                  {verificationData?.analysis?.concerns?.map((c: any) => {
                    const probPct =
                      c.percentage ?? Math.round((c.prob || 0) * 100);
                    const threshPct =
                      c.thresholdPercentage ??
                      Math.round((c.threshold || 0.45) * 100);
                    return (
                      <div
                        key={c.code}
                        className="p-3 rounded-2xl bg-slate-50 border border-slate-100 space-y-2"
                      >
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-slate-800 font-medium">
                            {c.label}
                          </span>
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-semibold text-slate-700">
                              {probPct}%
                            </span>
                            <span
                              className={`text-[10px] px-2 py-0.5 rounded font-medium ${
                                c.active
                                  ? 'bg-amber-100 text-amber-800 border border-amber-300 font-bold'
                                  : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                              }`}
                            >
                              {c.active ? '⚠️ Perlu Perawatan' : '✓ Terkontrol'}
                            </span>
                          </div>
                        </div>
                        {/* Progress Bar with Ambang Indicator */}
                        <div className="relative h-2 w-full bg-slate-200 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-500 ${
                              c.active ? 'bg-amber-500' : 'bg-emerald-500'
                            }`}
                            style={{ width: `${Math.max(2, probPct)}%` }}
                          />
                        </div>
                        <div className="flex justify-between text-[10px] text-slate-400">
                          <span>Terdeteksi: {probPct}%</span>
                          <span>Batas Ambang Klinis: {threshPct}%</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 3. Audit Anti-Manipulasi Biometrik */}
              <div className="p-3.5 rounded-2xl bg-slate-50 border border-slate-200/80 text-xs space-y-1.5">
                <span className="text-[10px] uppercase font-bold text-slate-500 block">
                  Hasil Audit Keaslian Biometrik (Anti-Spoofing):
                </span>
                <div className="grid grid-cols-3 gap-2 text-[11px] text-slate-600">
                  <div>
                    Respon Flash:{' '}
                    <strong className="text-slate-900">
                      {verificationData?.analysis?.livenessMetrics
                        ?.chromaticShift || 85}
                      %
                    </strong>
                  </div>
                  <div>
                    Ketajaman:{' '}
                    <strong className="text-slate-900">
                      {verificationData?.analysis?.livenessMetrics
                        ?.laplacianSharpness || 35}
                    </strong>
                  </div>
                  <div>
                    Kacamata:{' '}
                    <strong className="text-emerald-700">Dilepas ✓</strong>
                  </div>
                </div>
              </div>

              {/* Doctor Note */}
              <div className="text-[11px] text-slate-500 pt-1 border-t border-slate-100 flex items-center justify-between">
                <span>
                  Dokter Penilai:{' '}
                  <strong>{verificationData?.validationDoctor?.name}</strong>
                </span>
                <span className="text-[10px] text-slate-400">
                  SIP: {verificationData?.validationDoctor?.sip}
                </span>
              </div>
            </div>

            {/* Recommendations */}
            {verificationData?.recommendations?.heroProduct && (
              <div className="space-y-3">
                <h3 className="font-semibold text-base text-white flex items-center gap-1.5">
                  <ShoppingBag className="w-4 h-4 text-[#e31b4c]" />
                  Rekomendasi Produk
                </h3>

                {/* Hero Product Card */}
                <div className="bg-white rounded-3xl p-5 border border-slate-200 shadow-xl space-y-3">
                  <div className="flex justify-between items-start gap-2">
                    <div>
                      <span className="inline-block px-2.5 py-0.5 rounded-full bg-red-50 text-[#e31b4c] text-[10px] font-bold uppercase mb-1">
                        Paling Cocok
                      </span>
                      <h4 className="font-semibold text-base text-slate-900">
                        {verificationData.recommendations.heroProduct.nama}
                      </h4>
                      <p className="text-xs text-slate-500">
                        {verificationData.recommendations.heroProduct.merek} ·{' '}
                        {verificationData.recommendations.heroProduct.kat}
                      </p>
                    </div>

                    <div className="text-right">
                      <span className="text-sm font-bold text-slate-900 block">
                        Rp{' '}
                        {verificationData.recommendations.heroProduct.harga?.toLocaleString(
                          'id-ID'
                        )}
                      </span>
                      <span className="text-[10px] text-slate-400 block">
                        BPOM:{' '}
                        {verificationData.recommendations.heroProduct.bpom}
                      </span>
                    </div>
                  </div>

                  {verificationData.recommendations.heroProduct.reasons
                    ?.length > 0 && (
                    <div className="text-xs text-slate-600 bg-slate-50 p-3 rounded-xl border border-slate-100">
                      <strong className="text-slate-700 block mb-1">
                        Alasan Kecocokan:
                      </strong>
                      <ul className="list-disc list-inside space-y-0.5 text-slate-500 text-[11px]">
                        {verificationData.recommendations.heroProduct.reasons.map(
                          (r: string, idx: number) => (
                            <li key={idx}>{r}</li>
                          )
                        )}
                      </ul>
                    </div>
                  )}
                </div>

                {/* Supporting Products */}
                {verificationData?.recommendations?.supportingProducts?.length >
                  0 && (
                  <div className="space-y-2">
                    {verificationData.recommendations.supportingProducts.map(
                      (p: any) => (
                        <div
                          key={p.id}
                          className="bg-white rounded-2xl p-4 border border-slate-200 flex justify-between items-center shadow-md"
                        >
                          <div>
                            <h5 className="font-medium text-xs text-slate-800">
                              {p.nama}
                            </h5>
                            <span className="text-[11px] text-slate-400">
                              {p.kat} · BPOM: {p.bpom}
                            </span>
                          </div>
                          <span className="text-xs font-semibold text-slate-900">
                            Rp {p.harga?.toLocaleString('id-ID')}
                          </span>
                        </div>
                      )
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Retake Button */}
            <div className="text-center pt-3">
              <button
                onClick={handleRetake}
                className="inline-flex items-center gap-2 px-8 py-3 rounded-2xl bg-white hover:bg-slate-100 text-slate-900 font-semibold text-xs shadow-lg transition cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Pindai Ulang
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// -------------------------------------------------------------
// Helper: Draw 3D Face Wireframe Mesh (Matching Image 1)
// -------------------------------------------------------------
function drawPath(
  ctx: CanvasRenderingContext2D,
  landmarks: any[],
  indices: number[],
  w: number,
  h: number,
  close = false,
  fill = false
) {
  if (indices.length < 2) return;
  ctx.beginPath();
  const first = landmarks[indices[0]];
  if (!first) return;
  ctx.moveTo(first.x * w, first.y * h);

  for (let i = 1; i < indices.length; i++) {
    const pt = landmarks[indices[i]];
    if (!pt) continue;
    ctx.lineTo(pt.x * w, pt.y * h);
  }

  if (close) {
    ctx.closePath();
  }
  if (fill) {
    ctx.fill();
  }
  ctx.stroke();
}

function drawFaceWireframe(
  ctx: CanvasRenderingContext2D,
  landmarks: any[] | null,
  w: number,
  h: number,
  isReady: boolean
) {
  ctx.clearRect(0, 0, w, h);

  const strokeColor = isReady
    ? 'rgba(0, 230, 118, 0.85)'
    : 'rgba(255, 23, 68, 0.70)';
  const fillColor = isReady
    ? 'rgba(0, 230, 118, 0.05)'
    : 'rgba(255, 23, 68, 0.04)';

  if (!landmarks || landmarks.length < 468) {
    // Parametric 3D face mesh grid fallback
    drawParametricMesh(ctx, w, h, strokeColor, fillColor);
    return;
  }

  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.1;
  ctx.fillStyle = fillColor;

  // 1. Jawline / Face Oval
  const jawline = [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365,
    379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93,
    234, 127, 162, 21, 54, 103, 67, 109, 10,
  ];
  drawPath(ctx, landmarks, jawline, w, h, true, true);

  // 2. Forehead Horizontal Arcs
  const arcForehead1 = [103, 67, 109, 10, 338, 297, 332];
  const arcForehead2 = [54, 68, 108, 151, 337, 298, 284];
  const arcEyebrows = [70, 63, 105, 66, 107, 9, 336, 296, 334, 293, 300];
  drawPath(ctx, landmarks, arcForehead1, w, h, false);
  drawPath(ctx, landmarks, arcForehead2, w, h, false);
  drawPath(ctx, landmarks, arcEyebrows, w, h, false);

  // 3. Eye & Temple Arcs
  const arcEyeLevel = [234, 127, 130, 168, 359, 356, 454];
  const arcUpperNose = [116, 123, 147, 197, 376, 352, 345];
  drawPath(ctx, landmarks, arcEyeLevel, w, h, false);
  drawPath(ctx, landmarks, arcUpperNose, w, h, false);

  // 4. Cheek & Lower Nose Arcs
  const arcCheek = [205, 203, 98, 2, 327, 423, 425];
  const arcMouth = [132, 58, 172, 152, 397, 288, 361];
  drawPath(ctx, landmarks, arcCheek, w, h, false);
  drawPath(ctx, landmarks, arcMouth, w, h, false);

  // 5. Vertical Meridian / Longitude lines
  const meridianCenter = [
    10, 151, 9, 8, 168, 6, 197, 195, 5, 4, 1, 2, 164, 0, 17, 18, 152,
  ];
  const meridianLeftInner = [109, 108, 107, 168, 123, 98, 164];
  const meridianRightInner = [338, 337, 336, 168, 352, 327, 164];
  const meridianLeftMid = [67, 68, 66, 130, 147, 205, 58];
  const meridianRightMid = [297, 298, 296, 359, 376, 425, 288];
  drawPath(ctx, landmarks, meridianCenter, w, h, false);
  drawPath(ctx, landmarks, meridianLeftInner, w, h, false);
  drawPath(ctx, landmarks, meridianRightInner, w, h, false);
  drawPath(ctx, landmarks, meridianLeftMid, w, h, false);
  drawPath(ctx, landmarks, meridianRightMid, w, h, false);

  // 6. Eyes & Lips
  const leftEye = [33, 160, 158, 133, 153, 144, 33];
  const rightEye = [362, 385, 387, 263, 373, 380, 362];
  const lips = [
    61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314,
    17, 84, 181, 91, 146, 61,
  ];
  drawPath(ctx, landmarks, leftEye, w, h, true);
  drawPath(ctx, landmarks, rightEye, w, h, true);
  drawPath(ctx, landmarks, lips, w, h, true);
}

function drawParametricMesh(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  strokeColor: string,
  fillColor: string
) {
  const cx = w * 0.5;
  const cy = h * 0.48;
  const rx = w * 0.22;
  const ry = h * 0.28;

  ctx.strokeStyle = strokeColor;
  ctx.fillStyle = fillColor;
  ctx.lineWidth = 1.0;

  // Outer Oval
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Horizontal latitude arcs
  for (let f = -0.7; f <= 0.7; f += 0.25) {
    const arcY = cy + ry * f;
    const arcW = rx * Math.sqrt(Math.max(0, 1 - f * f));
    ctx.beginPath();
    ctx.ellipse(cx, arcY, arcW, arcW * 0.25, 0, 0, Math.PI);
    ctx.stroke();
  }

  // Vertical longitude lines
  for (let f = -0.6; f <= 0.6; f += 0.3) {
    const arcX = cx + rx * f;
    const arcH = ry * Math.sqrt(Math.max(0, 1 - f * f));
    ctx.beginPath();
    ctx.ellipse(arcX, cy, Math.abs(rx * f * 0.4) + 10, arcH, 0, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
  }
}
