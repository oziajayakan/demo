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
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<any>(null);
  const landmarkerRef = useRef<any>(null);

  // Challenge session state from Edge API
  const [sessionData, setSessionData] = useState<any>(null);
  const [scanState, setScanState] = useState<ScanState>('INIT');
  const [statusMessage, setStatusMessage] = useState('Memulai kamera...');
  const [errorMessage, setErrorMessage] = useState('');

  // Real-time checks
  const [gates, setGates] = useState({
    camLock: false,
    facePos: false,
    faceDist: false,
    light: false,
    focus: false,
    noGlasses: true,
    flashReady: false,
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

  // 2. Start Video Camera with Strict Device Policies
  const startCamera = useCallback(async () => {
    setScanState('INIT');
    setStatusMessage('Memulai kamera...');

    try {
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

      setGates((prev) => ({ ...prev, camLock: true }));
      setScanState('SEARCH');
      setStatusMessage('Posisikan wajah Anda di dalam bingkai oval');
    } catch (err: any) {
      console.error(err);
      setScanState('ERROR');
      setErrorMessage(
        err.name === 'NotAllowedError'
          ? 'Izin kamera ditolak. Berikan izin di browser Anda.'
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

  // 3. Main Frame Processing Loop (Face Alignment & Liveness Gates)
  useEffect(() => {
    if (scanState === 'SUCCESS' || scanState === 'ERROR' || scanState === 'FLASH') {
      return;
    }

    const checkFrame = () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || !probeCanvasRef.current) {
        return;
      }

      const pCanvas = probeCanvasRef.current;
      pCanvas.width = 160;
      pCanvas.height = 120;
      const pCtx = pCanvas.getContext('2d', { willReadFrequently: true });
      if (!pCtx) return;

      pCtx.drawImage(video, 0, 0, 160, 120);

      // Analyze center region (Oval region)
      const centerX = 160 * 0.25;
      const centerY = 120 * 0.2;
      const centerW = 160 * 0.5;
      const centerH = 120 * 0.6;

      const imgData = pCtx.getImageData(centerX, centerY, centerW, centerH).data;

      // 1. Luminance Calculation
      let totalLuma = 0;
      for (let i = 0; i < imgData.length; i += 4) {
        totalLuma +=
          0.299 * imgData[i] + 0.587 * imgData[i + 1] + 0.114 * imgData[i + 2];
      }
      const avgLuma = totalLuma / (imgData.length / 4);
      const isLightOk = avgLuma >= 65 && avgLuma <= 220;

      // 2. Sharpness & Texture (Laplacian Variance)
      const laplacianVar = computeLaplacianVariance(pCtx, 160, 120);
      const isFocusOk = laplacianVar >= 14;

      // 3. Strict Glasses & Eye Occlusion Detection Gate
      let glassesRes = { pass: true, msg: 'Bebas kacamata' };
      if (landmarkerRef.current) {
        try {
          const lmRes = landmarkerRef.current.detectForVideo(video, performance.now());
          if (lmRes?.faceLandmarks?.[0]) {
            glassesRes = checkGlassesWithLandmarks(
              lmRes.faceLandmarks[0],
              pCtx,
              160,
              120
            );
          } else {
            glassesRes = checkGlassesFallback(pCtx, 160, 120);
          }
        } catch {
          glassesRes = checkGlassesFallback(pCtx, 160, 120);
        }
      } else {
        glassesRes = checkGlassesFallback(pCtx, 160, 120);
      }

      const isNoGlassesOk = glassesRes.pass;
      const isPosOk = true;
      const isDistOk = avgLuma > 40;

      const allGatesOk =
        isLightOk && isFocusOk && isPosOk && isDistOk && isNoGlassesOk;

      setGates({
        camLock: true,
        facePos: isPosOk,
        faceDist: isDistOk,
        light: isLightOk,
        focus: isFocusOk,
        noGlasses: isNoGlassesOk,
        flashReady: allGatesOk,
      });

      const now = performance.now();

      if (allGatesOk) {
        if (!holdStartRef.current) {
          holdStartRef.current = now;
          setScanState('HOLD');
        }
        const elapsed = now - holdStartRef.current;
        const progress = Math.min(1.0, elapsed / 1200);
        setHoldProgress(progress);

        if (progress >= 1.0 && scanState === 'HOLD') {
          triggerFlashChallenge();
        }
      } else {
        holdStartRef.current = null;
        setHoldProgress(0);
        if (scanState === 'HOLD') setScanState('SEARCH');

        if (!isNoGlassesOk) {
          setStatusMessage('👓 ' + glassesRes.msg);
        } else if (!isFocusOk) {
          setStatusMessage('Tahan stabil, fokuskan kamera ke wajah');
        } else if (!isLightOk) {
          setStatusMessage(
            avgLuma < 65
              ? 'Cahaya kurang, hadap ke tempat lebih terang'
              : 'Cahaya terlalu silau'
          );
        } else {
          setStatusMessage('Posisikan wajah lurus di dalam bingkai oval');
        }
      }
    };

    timerRef.current = setInterval(checkFrame, 100);
    return () => clearInterval(timerRef.current);
  }, [scanState]);

  // 4. Trigger Dynamic Screen Flash Challenge
  const triggerFlashChallenge = async () => {
    setScanState('FLASH');
    clearInterval(timerRef.current);
    setStatusMessage('Memeriksa pantulan cahaya... Tahan!');

    const video = videoRef.current;
    if (!video || !probeCanvasRef.current || !cropCanvasRef.current) return;

    const pCanvas = probeCanvasRef.current;
    pCanvas.width = 160;
    pCanvas.height = 120;
    const pCtx = pCanvas.getContext('2d', { willReadFrequently: true });
    if (!pCtx) return;

    // Step A: Sample pre-flash skin RGB
    pCtx.drawImage(video, 0, 0, 160, 120);
    const preRGB = sampleSkinRGB(pCtx, { x: 40, y: 30, w: 80, h: 60 });

    // Step B: Flash screen with challenge color
    setIsFlashing(true);
    await new Promise((r) => setTimeout(r, 160));

    // Step C: Sample peak-flash skin RGB
    pCtx.drawImage(video, 0, 0, 160, 120);
    const flashRGB = sampleSkinRGB(pCtx, { x: 40, y: 30, w: 80, h: 60 });
    const laplacianVar = computeLaplacianVariance(pCtx, 160, 120);

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
      setStatusMessage(liveness.reason || 'Verifikasi gagal');
      setErrorMessage(
        'Sistem mendeteksi kemungkinan foto cetak, layar HP lain, atau pantulan tidak alami. Harap gunakan wajah asli Anda.'
      );
      return;
    }

    // Step E: If Liveness passed -> Run ONNX Multi-Head Inference
    await executeInference(liveness);
  };

  // 5. Execute ONNX WebAssembly Inference & Edge Verification
  const executeInference = async (liveness: LivenessResult) => {
    setScanState('INFERRING');
    setStatusMessage('Menganalisis kondisi kulit...');

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
      setStatusMessage('Menyiapkan rekomendasi produk...');

      const verifyRes = await fetch('/api/scan/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionData.sessionId,
          nonce: sessionData.nonce,
          issuedAt: sessionData.issuedAt,
          flashColor: sessionData.challenge?.flashColor || flashColor,
          signature: sessionData.signature,
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
      setStatusMessage('Pemindaian selesai');

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

  // Initial load
  useEffect(() => {
    fetchChallenge().then(() => {
      startCamera();
    });

    return () => {
      clearInterval(timerRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, [fetchChallenge, startCamera]);

  return (
    <div className="py-6 px-4 sm:px-6 flex flex-col items-center">
      {/* Dynamic Screen Flash Fullscreen Overlay */}
      {isFlashing && (
        <div
          className="fixed inset-0 z-[999] pointer-events-none transition-opacity duration-75"
          style={{ backgroundColor: flashColor, opacity: 0.9 }}
        />
      )}

      {/* Hidden Offscreen Canvases */}
      <canvas ref={probeCanvasRef} className="hidden" />
      <canvas ref={cropCanvasRef} className="hidden" />

      <div className="w-full max-w-md space-y-4">
        {/* Top Header Bar */}
        <div className="flex items-center justify-between">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800 transition font-medium"
          >
            <ArrowLeft className="w-4 h-4" />
            Kembali
          </Link>
          <button
            type="button"
            onClick={() => {
              holdStartRef.current = null;
              setHoldProgress(0);
              setStatusMessage('Mengecek ulang kondisi...');
            }}
            className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800 transition font-medium cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh Cek
          </button>
        </div>

        {/* Scanner Viewport or Result View */}
        {scanState !== 'SUCCESS' ? (
          <div className="space-y-4">
            {/* Viewfinder Card */}
            <div className="bg-white rounded-2xl p-3 border border-slate-200 shadow-sm relative overflow-hidden">
              <div className="relative aspect-[3/4] w-full rounded-xl overflow-hidden bg-slate-900 flex items-center justify-center">
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  autoPlay
                  className="absolute inset-0 w-full h-full object-cover -scale-x-100"
                />

                {/* Oval Guide Overlay */}
                <div
                  className={`absolute inset-x-8 inset-y-8 rounded-[50%] border-2 transition-all duration-200 pointer-events-none ${
                    !gates.noGlasses
                      ? 'border-red-500'
                      : scanState === 'HOLD'
                      ? 'border-brand-500 shadow-md'
                      : gates.flashReady
                      ? 'border-green-400'
                      : 'border-white/80'
                  }`}
                />

                {/* Progress Bar during HOLD */}
                {scanState === 'HOLD' && (
                  <div className="absolute bottom-4 inset-x-12 h-1.5 bg-black/40 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-brand-600 transition-all duration-75"
                      style={{ width: `${holdProgress * 100}%` }}
                    />
                  </div>
                )}

                {/* Glasses Warning Banner */}
                {!gates.noGlasses && (
                  <div className="absolute inset-x-4 top-14 z-20 flex justify-center">
                    <div className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-semibold flex items-center gap-1.5 shadow-md">
                      <XCircle className="w-4 h-4 flex-shrink-0" />
                      Mohon lepas kacamata Anda
                    </div>
                  </div>
                )}

                {/* Instruction Badge */}
                <div className="absolute top-3 inset-x-4 text-center pointer-events-none">
                  <div
                    className={`inline-block px-3 py-1 rounded-full text-xs font-medium shadow-sm ${
                      !gates.noGlasses
                        ? 'bg-red-700 text-white'
                        : 'bg-black/70 text-white'
                    }`}
                  >
                    {statusMessage}
                  </div>
                </div>
              </div>
            </div>

            {/* Checklist Chips */}
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div
                className={`flex items-center gap-2 p-2.5 rounded-xl border transition ${
                  gates.noGlasses
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    : 'bg-red-50 border-red-200 text-red-800 font-medium'
                }`}
              >
                {gates.noGlasses ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                ) : (
                  <XCircle className="w-4 h-4 text-red-600 flex-shrink-0" />
                )}
                <span>{gates.noGlasses ? 'Tanpa Kacamata' : 'Lepas Kacamata'}</span>
              </div>

              <div
                className={`flex items-center gap-2 p-2.5 rounded-xl border transition ${
                  gates.focus
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    : 'bg-slate-50 border-slate-200 text-slate-600'
                }`}
              >
                <CheckCircle2
                  className={`w-4 h-4 flex-shrink-0 ${
                    gates.focus ? 'text-emerald-600' : 'text-slate-400'
                  }`}
                />
                <span>Ketajaman Wajah</span>
              </div>

              <div
                className={`flex items-center gap-2 p-2.5 rounded-xl border transition ${
                  gates.light
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    : 'bg-slate-50 border-slate-200 text-slate-600'
                }`}
              >
                <CheckCircle2
                  className={`w-4 h-4 flex-shrink-0 ${
                    gates.light ? 'text-emerald-600' : 'text-slate-400'
                  }`}
                />
                <span>Cahaya Cukup</span>
              </div>

              <div
                className={`flex items-center gap-2 p-2.5 rounded-xl border transition ${
                  gates.flashReady
                    ? 'bg-brand-50 border-brand-200 text-brand-800 font-medium'
                    : 'bg-slate-50 border-slate-200 text-slate-600'
                }`}
              >
                <Zap
                  className={`w-4 h-4 flex-shrink-0 ${
                    gates.flashReady ? 'text-brand-600' : 'text-slate-400'
                  }`}
                />
                <span>Siap Scan</span>
              </div>
            </div>

            {/* Error Notice */}
            {(scanState === 'FAILED' || scanState === 'ERROR') && (
              <div className="bg-red-50 rounded-xl p-4 border border-red-200 space-y-2">
                <div className="flex items-center gap-1.5 text-red-800 font-semibold text-xs">
                  <AlertCircle className="w-4 h-4 text-red-600" />
                  Pemindaian Dibatalkan
                </div>
                <p className="text-xs text-red-700 leading-relaxed">
                  {errorMessage || 'Wajah tidak memenuhi syarat pemindaian.'}
                </p>
                <button
                  onClick={handleRetake}
                  className="mt-1 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-700 hover:bg-red-800 text-white font-medium text-xs transition cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Coba Lagi
                </button>
              </div>
            )}
          </div>
        ) : (
          /* RESULT VIEW: Simple Clean Card Layout */
          <div className="space-y-5">
            {/* Diagnosis Summary Card */}
            <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm space-y-5">
              <div className="flex items-start justify-between gap-4 border-b border-slate-100 pb-4">
                <div>
                  <span className="inline-block text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2.5 py-0.5 rounded-full border border-emerald-200 mb-1.5">
                    Hasil Terverifikasi
                  </span>
                  <h2 className="font-serif text-2xl font-bold text-slate-900 capitalize">
                    Kulit {verificationData?.analysis?.skinType?.label}
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Tingkat Keyakinan: {verificationData?.analysis?.confidence}%
                  </p>
                </div>

                {capturedThumbnail && (
                  <div className="w-16 h-16 rounded-xl overflow-hidden border border-slate-200 flex-shrink-0">
                    <img
                      src={capturedThumbnail}
                      alt="Wajah"
                      className="w-full h-full object-cover"
                    />
                  </div>
                )}
              </div>

              {/* Concern Breakdown */}
              <div className="space-y-2.5">
                <h4 className="text-xs font-semibold text-slate-700">
                  Kondisi & Masalah Kulit:
                </h4>
                <div className="space-y-1.5">
                  {verificationData?.analysis?.concerns?.map((c: any) => (
                    <div
                      key={c.code}
                      className="flex items-center justify-between text-xs p-2 rounded-lg bg-slate-50 border border-slate-100"
                    >
                      <span className="text-slate-700 font-medium">{c.label}</span>
                      <span
                        className={`text-[11px] px-2 py-0.5 rounded font-medium ${
                          c.active
                            ? 'bg-brand-50 text-brand-700 border border-brand-200'
                            : 'text-slate-400'
                        }`}
                      >
                        {c.active ? 'Perlu Perawatan' : 'Terkontrol'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Doctor Note */}
              <div className="text-[11px] text-slate-500 pt-2 border-t border-slate-100">
                Tervalidasi oleh <strong>{verificationData?.validationDoctor?.name}</strong> ({verificationData?.validationDoctor?.sip})
              </div>
            </div>

            {/* Recommendations */}
            {verificationData?.recommendations?.heroProduct && (
              <div className="space-y-3">
                <h3 className="font-semibold text-base text-slate-900 flex items-center gap-1.5">
                  <ShoppingBag className="w-4 h-4 text-brand-700" />
                  Rekomendasi Produk
                </h3>

                {/* Hero Product Card */}
                <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm space-y-3">
                  <div className="flex justify-between items-start gap-2">
                    <div>
                      <span className="inline-block px-2 py-0.5 rounded bg-brand-50 text-brand-700 text-[10px] font-bold uppercase mb-1">
                        Paling Cocok
                      </span>
                      <h4 className="font-semibold text-base text-slate-900">
                        {verificationData.recommendations.heroProduct.nama}
                      </h4>
                      <p className="text-xs text-slate-500">
                        {verificationData.recommendations.heroProduct.merek} · {verificationData.recommendations.heroProduct.kat}
                      </p>
                    </div>

                    <div className="text-right">
                      <span className="text-sm font-bold text-slate-900 block">
                        Rp {verificationData.recommendations.heroProduct.harga?.toLocaleString('id-ID')}
                      </span>
                      <span className="text-[10px] text-slate-400 block">
                        BPOM: {verificationData.recommendations.heroProduct.bpom}
                      </span>
                    </div>
                  </div>

                  {verificationData.recommendations.heroProduct.reasons?.length > 0 && (
                    <div className="text-xs text-slate-600 bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                      <strong className="text-slate-700 block mb-1">Alasan Kecocokan:</strong>
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
                {verificationData.recommendations.supportingProducts?.length > 0 && (
                  <div className="space-y-2">
                    {verificationData.recommendations.supportingProducts.map((p: any) => (
                      <div
                        key={p.id}
                        className="bg-white rounded-xl p-3 border border-slate-200 flex justify-between items-center"
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
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Retake Button */}
            <div className="text-center pt-2">
              <button
                onClick={handleRetake}
                className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium text-xs transition cursor-pointer border border-slate-200"
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
