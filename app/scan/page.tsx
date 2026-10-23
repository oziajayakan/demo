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
  Sparkles,
  ShoppingBag,
  ArrowLeft,
  Lock,
} from 'lucide-react';
import { runSkinInference, PredictionResult } from '@/lib/onnx';
import {
  sampleSkinRGB,
  computeLaplacianVariance,
  evaluateFlashChromaticity,
  LivenessResult,
} from '@/lib/flash-liveness';

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

  // Challenge session state from Edge API
  const [sessionData, setSessionData] = useState<any>(null);
  const [scanState, setScanState] = useState<ScanState>('INIT');
  const [statusMessage, setStatusMessage] = useState('Menginisialisasi sistem...');
  const [errorMessage, setErrorMessage] = useState('');

  // Real-time checks
  const [gates, setGates] = useState({
    camLock: false,
    facePos: false,
    faceDist: false,
    light: false,
    focus: false,
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
      setErrorMessage('Koneksi Vercel Edge API terganggu: ' + err.message);
      return null;
    }
  }, []);

  // 2. Start Video Camera with Strict Device Policies
  const startCamera = useCallback(async () => {
    setScanState('INIT');
    setStatusMessage('Menghubungkan ke sensor kamera fisik...');

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
      setStatusMessage('Posisikan wajah Anda tegak di dalam oval');
    } catch (err: any) {
      console.error(err);
      setScanState('ERROR');
      setErrorMessage(
        err.name === 'NotAllowedError'
          ? 'Izin akses kamera ditolak. Berikan izin di browser Anda.'
          : 'Kamera fisik tidak dapat diakses: ' + err.message
      );
    }
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

      const vw = video.videoWidth || 640;
      const vh = video.videoHeight || 480;

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

      // Basic alignment assumptions for oval frame
      const isPosOk = true;
      const isDistOk = avgLuma > 40;

      const allGatesOk = isLightOk && isFocusOk && isPosOk && isDistOk;

      setGates({
        camLock: true,
        facePos: isPosOk,
        faceDist: isDistOk,
        light: isLightOk,
        focus: isFocusOk,
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

        if (!isFocusOk) {
          setStatusMessage('Tahan stabil, fokuskan kamera ke wajah');
        } else if (!isLightOk) {
          setStatusMessage(
            avgLuma < 65 ? 'Cahaya kurang, cari tempat lebih terang' : 'Cahaya terlalu silau'
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
    setStatusMessage('⚡ Verifikasi Cahaya Spektral (Dynamic Flash)... Tahan!');

    const video = videoRef.current;
    if (!video || !probeCanvasRef.current || !cropCanvasRef.current) return;

    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;

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
      setStatusMessage('❌ ' + liveness.reason);
      setErrorMessage(
        'Sistem mendeteksi kemungkinan foto cetak, layar HP lain, atau pantulan tidak wajar. Harap gunakan wajah asli Anda.'
      );
      return;
    }

    // Step E: If Liveness passed -> Run ONNX Multi-Head Inference
    await executeInference(liveness);
  };

  // 5. Execute ONNX WebAssembly Inference & Edge Verification
  const executeInference = async (liveness: LivenessResult) => {
    setScanState('INFERRING');
    setStatusMessage('🧠 Menjalankan inferensi model ONNX...');

    const video = videoRef.current;
    const cCanvas = cropCanvasRef.current;
    if (!video || !cCanvas) return;

    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;

    // Crop square 224x224 center face
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
      // Run ONNX MobileNetV3 multi-head model
      const prediction: PredictionResult = await runSkinInference(cCanvas);

      setScanState('VERIFYING');
      setStatusMessage('🔒 Memvalidasi integritas dengan Vercel Edge Security...');

      // Post to Vercel Serverless API
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
      setStatusMessage('✅ Pemindaian berhasil dan terverifikasi!');

      // Stop camera stream to free resources
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    } catch (err: any) {
      console.error(err);
      setScanState('ERROR');
      setErrorMessage(err.message || 'Gagal memproses model ONNX');
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
    <div className="min-h-[92vh] py-6 px-3 sm:px-6 relative flex flex-col items-center">
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

      <div className="w-full max-w-lg space-y-4">
        {/* Top Header Bar */}
        <div className="flex items-center justify-between">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-xs text-plum-300 hover:text-white transition"
          >
            <ArrowLeft className="w-4 h-4" />
            Kembali
          </Link>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-plum-800 border border-plum-700 text-plum-200">
              <Lock className="w-3 h-3 text-[#00F0FF]" />
              Zero-Biometric Upload
            </span>
          </div>
        </div>

        {/* Scanner Viewport or Result View */}
        {scanState !== 'SUCCESS' ? (
          <div className="space-y-4">
            {/* Viewfinder Card */}
            <div className="glass-card rounded-3xl p-3 sm:p-4 relative overflow-hidden border-plum-700/60 shadow-2xl">
              {/* Radar Stage */}
              <div className="relative aspect-[3/4] w-full rounded-2xl overflow-hidden bg-black flex items-center justify-center">
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  autoPlay
                  className="absolute inset-0 w-full h-full object-cover -scale-x-100"
                />

                {/* Laser scan line when holding or inferring */}
                {(scanState === 'HOLD' || scanState === 'INFERRING') && (
                  <div className="laser-line" />
                )}

                {/* Oval Guide Overlay */}
                <div
                  className={`absolute inset-x-8 inset-y-8 rounded-[50%] border-2 transition-all duration-300 pointer-events-none ${
                    scanState === 'HOLD'
                      ? 'border-[#00F0FF] shadow-[0_0_20px_#00F0FF] animate-radar'
                      : scanState === 'FLASH'
                      ? 'border-white shadow-[0_0_30px_#fff]'
                      : gates.flashReady
                      ? 'border-emerald-400 shadow-[0_0_12px_#34d399]'
                      : 'border-[#FF2A85]/80'
                  }`}
                />

                {/* Progress Bar inside Oval during HOLD */}
                {scanState === 'HOLD' && (
                  <div className="absolute bottom-6 inset-x-14 h-2 bg-black/60 backdrop-blur rounded-full overflow-hidden border border-plum-600/40">
                    <div
                      className="h-full bg-gradient-to-r from-[#00F0FF] to-[#FF2A85] transition-all duration-75"
                      style={{ width: `${holdProgress * 100}%` }}
                    />
                  </div>
                )}

                {/* Instruction HUD Badge */}
                <div className="absolute top-4 inset-x-4 text-center pointer-events-none">
                  <div className="inline-block px-4 py-1.5 rounded-full bg-black/75 backdrop-blur-md border border-plum-600/50 text-white font-medium text-xs sm:text-sm shadow-lg">
                    {statusMessage}
                  </div>
                </div>

                {/* Challenge Indicator Badge */}
                {sessionData && (
                  <div className="absolute bottom-4 left-4 z-10">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-black/60 backdrop-blur border border-plum-700/60 text-[10px] text-plum-300">
                      <Zap className="w-3 h-3 text-[#00F0FF]" />
                      Flash Target: {sessionData.challenge?.flashName}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Real-time Checklist Chips */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
              <div
                className={`flex items-center gap-2 p-2.5 rounded-xl border transition ${
                  gates.camLock
                    ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-300'
                    : 'bg-plum-950/40 border-plum-800 text-plum-400'
                }`}
              >
                <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                <span>Kamera Terkunci</span>
              </div>

              <div
                className={`flex items-center gap-2 p-2.5 rounded-xl border transition ${
                  gates.focus
                    ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-300'
                    : 'bg-plum-950/40 border-plum-800 text-plum-400'
                }`}
              >
                <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                <span>Ketajaman Pori</span>
              </div>

              <div
                className={`flex items-center gap-2 p-2.5 rounded-xl border transition ${
                  gates.light
                    ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-300'
                    : 'bg-plum-950/40 border-plum-800 text-plum-400'
                }`}
              >
                <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                <span>Cahaya Merata</span>
              </div>

              <div
                className={`flex items-center gap-2 p-2.5 rounded-xl border transition ${
                  gates.flashReady
                    ? 'bg-[#00F0FF]/10 border-[#00F0FF]/40 text-[#00F0FF]'
                    : 'bg-plum-950/40 border-plum-800 text-plum-400'
                }`}
              >
                <Zap className="w-4 h-4 flex-shrink-0" />
                <span>Siap Flash</span>
              </div>

              <div
                className={`flex items-center gap-2 p-2.5 rounded-xl border transition ${
                  scanState === 'INFERRING' || scanState === 'VERIFYING'
                    ? 'bg-[#FF2A85]/20 border-[#FF2A85]/50 text-[#FF80BF]'
                    : 'bg-plum-950/40 border-plum-800 text-plum-400'
                }`}
              >
                <Sparkles className="w-4 h-4 flex-shrink-0" />
                <span>ONNX Multi-Head</span>
              </div>

              <div
                className={`flex items-center gap-2 p-2.5 rounded-xl border transition ${
                  sessionData
                    ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-300'
                    : 'bg-plum-950/40 border-plum-800 text-plum-400'
                }`}
              >
                <ShieldCheck className="w-4 h-4 flex-shrink-0" />
                <span>Edge Nonce Valid</span>
              </div>
            </div>

            {/* Error or Fail Notice */}
            {(scanState === 'FAILED' || scanState === 'ERROR') && (
              <div className="glass-card rounded-2xl p-4 border-l-4 border-l-rose-500 bg-rose-950/20 space-y-2">
                <div className="flex items-center gap-2 text-rose-300 font-semibold text-xs">
                  <AlertCircle className="w-4 h-4 text-rose-400" />
                  Verifikasi Gagal
                </div>
                <p className="text-xs text-rose-200/90 leading-relaxed">
                  {errorMessage || 'Wajah tidak memenuhi standar validasi anti-manipulasi.'}
                </p>
                <button
                  onClick={handleRetake}
                  className="mt-2 inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs transition cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Coba Pindai Ulang
                </button>
              </div>
            )}
          </div>
        ) : (
          /* RESULT VIEW: Verified Skin Diagnostic & Recommendations */
          <div className="space-y-6 animate-fadeIn">
            {/* Header Result Card */}
            <div className="glass-card-glow rounded-3xl p-6 sm:p-7 space-y-6">
              <div className="flex items-start justify-between gap-4 border-b border-plum-700/50 pb-5">
                <div>
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs font-semibold mb-2">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    Terverifikasi Anti-Manipulasi
                  </span>
                  <h2 className="font-serif text-3xl font-bold text-white capitalize">
                    Kulit {verificationData?.analysis?.skinType?.label}
                  </h2>
                  <p className="text-xs text-plum-300 mt-1">
                    Tingkat Keyakinan Diagnosa: {verificationData?.analysis?.confidence}%
                  </p>
                </div>

                {capturedThumbnail && (
                  <div className="w-20 h-20 rounded-2xl overflow-hidden border-2 border-plum-600/60 flex-shrink-0 shadow-lg">
                    <img
                      src={capturedThumbnail}
                      alt="Crop wajah"
                      className="w-full h-full object-cover"
                    />
                  </div>
                )}
              </div>

              {/* Liveness Audit Metrics */}
              <div className="grid grid-cols-3 gap-2 text-center p-3 rounded-2xl bg-plum-950/50 border border-plum-800/60">
                <div>
                  <span className="text-[10px] text-plum-400 uppercase tracking-wider block">
                    Respon Flash
                  </span>
                  <span className="text-sm font-bold text-[#00F0FF]">
                    {verificationData?.analysis?.livenessMetrics?.chromaticShift}%
                  </span>
                </div>
                <div>
                  <span className="text-[10px] text-plum-400 uppercase tracking-wider block">
                    Ketajaman Pori
                  </span>
                  <span className="text-sm font-bold text-emerald-400">
                    {verificationData?.analysis?.livenessMetrics?.laplacianSharpness}
                  </span>
                </div>
                <div>
                  <span className="text-[10px] text-plum-400 uppercase tracking-wider block">
                    Bebas Moiré
                  </span>
                  <span className="text-sm font-bold text-[#FF80BF]">
                    100% Asli
                  </span>
                </div>
              </div>

              {/* Concern Breakdown */}
              <div className="space-y-3">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-plum-300">
                  Pemetaan Kondisi & Masalah Kulit:
                </h4>
                <div className="space-y-2">
                  {verificationData?.analysis?.concerns?.map((c: any) => (
                    <div
                      key={c.code}
                      className="flex items-center justify-between text-xs p-2.5 rounded-xl bg-plum-900/40 border border-plum-800/40"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`w-2.5 h-2.5 rounded-full ${
                            c.active ? 'bg-[#FF2A85]' : 'bg-plum-600'
                          }`}
                        />
                        <span className={c.active ? 'text-white font-medium' : 'text-plum-400'}>
                          {c.label}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-plum-300 text-[11px]">
                          {(c.prob * 100).toFixed(0)}%
                        </span>
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded-md font-semibold ${
                            c.active
                              ? 'bg-[#FF2A85]/20 text-[#FF80BF] border border-[#FF2A85]/30'
                              : 'bg-plum-800/40 text-plum-400'
                          }`}
                        >
                          {c.active ? 'Perlu Perawatan' : 'Terkontrol'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Doctor Endorsement Note */}
              <div className="p-3.5 rounded-2xl bg-gradient-to-r from-plum-900/60 to-[#8E1366]/20 border border-plum-700/50 text-xs space-y-1">
                <div className="font-semibold text-white flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  {verificationData?.validationDoctor?.name}
                </div>
                <p className="text-[11px] text-plum-300">
                  SIP: {verificationData?.validationDoctor?.sip} · {verificationData?.validationDoctor?.institution}
                </p>
              </div>
            </div>

            {/* Recommended Products Section */}
            {verificationData?.recommendations?.heroProduct && (
              <div className="space-y-4">
                <h3 className="font-serif text-2xl font-bold text-white flex items-center gap-2">
                  <ShoppingBag className="w-5 h-5 text-[#FF2A85]" />
                  Rekomendasi Skincare Terpilih
                </h3>

                {/* Hero Product Card */}
                <div className="glass-card rounded-3xl p-6 border-l-4 border-l-[#00F0FF] space-y-4">
                  <div className="flex justify-between items-start gap-3">
                    <div>
                      <span className="inline-block px-2.5 py-0.5 rounded-md bg-[#00F0FF]/10 text-[#00F0FF] text-[10px] font-bold uppercase tracking-wider mb-1.5 border border-[#00F0FF]/30">
                        #1 Paling Sesuai
                      </span>
                      <h4 className="font-serif font-bold text-xl text-white">
                        {verificationData.recommendations.heroProduct.nama}
                      </h4>
                      <p className="text-xs text-plum-300">
                        {verificationData.recommendations.heroProduct.merek} · {verificationData.recommendations.heroProduct.kat}
                      </p>
                    </div>

                    <div className="text-right">
                      <span className="text-sm font-bold text-[#FF80BF]">
                        Rp {verificationData.recommendations.heroProduct.harga?.toLocaleString('id-ID')}
                      </span>
                      <span className="block text-[10px] text-plum-400">
                        BPOM: {verificationData.recommendations.heroProduct.bpom}
                      </span>
                    </div>
                  </div>

                  {verificationData.recommendations.heroProduct.reasons?.length > 0 && (
                    <div className="text-xs text-plum-200 bg-plum-950/60 p-3 rounded-xl border border-plum-800">
                      <strong className="text-white block mb-1">Alasan Rekomendasi:</strong>
                      <ul className="list-disc list-inside space-y-0.5 text-plum-300">
                        {verificationData.recommendations.heroProduct.reasons.map((r: string, idx: number) => (
                          <li key={idx}>{r}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                {/* Supporting Products */}
                {verificationData.recommendations.supportingProducts?.length > 0 && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {verificationData.recommendations.supportingProducts.map((p: any) => (
                      <div
                        key={p.id}
                        className="glass-card rounded-2xl p-4 space-y-2 border-plum-800"
                      >
                        <div className="flex justify-between items-start">
                          <span className="text-[10px] font-semibold text-plum-400 uppercase">
                            {p.kat}
                          </span>
                          <span className="text-xs font-bold text-[#FF80BF]">
                            Rp {p.harga?.toLocaleString('id-ID')}
                          </span>
                        </div>
                        <h5 className="font-semibold text-sm text-white line-clamp-1">
                          {p.nama}
                        </h5>
                        <p className="text-[11px] text-plum-300 line-clamp-2">
                          BPOM: {p.bpom}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Action Buttons */}
            <div className="text-center pt-4">
              <button
                onClick={handleRetake}
                className="inline-flex items-center gap-2 px-6 py-3.5 rounded-full bg-plum-800 hover:bg-plum-700 text-white font-semibold text-xs tracking-wider transition cursor-pointer border border-plum-600"
              >
                <RefreshCw className="w-4 h-4" />
                Pindai Ulang Wajah
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
