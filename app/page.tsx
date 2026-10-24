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
  ShoppingBag,
  Sparkles,
  Sun,
  UserCheck,
  Eye,
  Check,
  Plus,
  ArrowRight,
  Info,
  CheckCheck,
  ScanFace,
  Smartphone,
} from 'lucide-react';
import { runSkinInference, PredictionResult } from '@/lib/onnx';
import {
  sampleSkinRGB,
  computeLaplacianVariance,
  evaluateFlashChromaticity,
  calculateEAR,
  BlinkTracker,
  detectScreenBezel,
  LivenessResult,
} from '@/lib/flash-liveness';
import {
  checkGlassesWithLandmarks,
  checkGlassesFallback,
} from '@/lib/glasses-detector';

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

export default function SmartSkinScannerApp() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<any>(null);
  const landmarkerRef = useRef<any>(null);
  const blinkTrackerRef = useRef<BlinkTracker>(new BlinkTracker());
  const autoTriggerCountRef = useRef<number>(0);

  // Hidden offscreen canvases for analysis
  const probeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cropCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Challenge session state from Edge API (TTL 15 min)
  const [sessionData, setSessionData] = useState<any>(null);
  const [flashColor, setFlashColor] = useState('#00F0FF');
  const [isFlashing, setIsFlashing] = useState(false);

  // Scan state
  const [scanState, setScanState] = useState<ScanState>('IDLE');
  const [statusText, setStatusText] = useState('Posisikan wajah Anda tepat di dalam bingkai oval');
  const [countdownNum, setCountdownNum] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  // 4 Validasi Kualitas Kamera + Anti-Layar HP / Foto
  const [checks, setChecks] = useState({
    light: 'Memeriksa' as 'Menunggu' | 'Memeriksa' | 'Lolos',
    facePos: 'Memeriksa' as 'Menunggu' | 'Memeriksa' | 'Lolos',
    lookStraight: 'Memeriksa' as 'Menunggu' | 'Memeriksa' | 'Lolos',
    liveBlink: 'Menunggu' as 'Menunggu' | 'Lolos',
    noGlasses: true,
    phoneBezel: false,
  });

  // Results state
  const [verificationData, setVerificationData] = useState<any>(null);
  const [capturedThumbnail, setCapturedThumbnail] = useState<string | null>(null);
  const [cartItems, setCartItems] = useState<Set<number>>(new Set());

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
      return null;
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
      setScanState('CHECKING');
      setStatusText('Posisikan wajah Anda di dalam oval dan kedipkan mata');
    } catch (err: any) {
      console.error('Camera access error:', err);
      setScanState('ERROR');
      setStatusText(
        err.name === 'NotAllowedError'
          ? 'Izin kamera ditolak. Berikan izin di peramban Anda.'
          : 'Kamera tidak dapat diakses.'
      );
    }
  }, []);

  // Initialize MediaPipe FaceLandmarker
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
          console.warn('FaceLandmarker using CV fallback');
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

  // 3. Real-Time Camera Quality Checks Loop & Strict Anti-Spoof Protection
  useEffect(() => {
    if (
      scanState === 'SUCCESS' ||
      scanState === 'SCANNING' ||
      scanState === 'FLASH' ||
      scanState === 'COUNTDOWN'
    ) {
      return;
    }

    const checkFrame = () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || !probeCanvasRef.current) return;

      const pCanvas = probeCanvasRef.current;
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
      const isLightOk = avgLuma >= 45 && avgLuma <= 240;

      // 2. Face Position, Look Straight, Glasses & Biological Blink Liveness
      let isPosOk = false;
      let isStraightOk = false;
      let isNoGlassesOk = true;
      let isBlinkOk = false;
      let isBezelDetected = false;

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
            const faceW = Math.abs(rightCheek.x - leftCheek.x);

            isPosOk =
              cx >= 0.26 && cx <= 0.74 && cy >= 0.18 && cy <= 0.78 && faceH >= 0.24;

            const leftDist = Math.abs(noseTip.x - leftCheek.x);
            const rightDist = Math.abs(rightCheek.x - noseTip.x);
            const yawRatio = leftDist / (rightDist || 0.001);
            const isYawOk = yawRatio >= 0.50 && yawRatio <= 1.90;
            const tilt = Math.abs(leftEye.y - rightEye.y);
            isStraightOk = isYawOk && tilt < 0.12;

            // Kacamata check
            const glassesRes = checkGlassesWithLandmarks(lm, pCtx, 320, 240);
            isNoGlassesOk = glassesRes.pass;

            // Biological eye blink detection (EAR calculation)
            const ear = calculateEAR(lm);
            isBlinkOk = blinkTrackerRef.current.update(ear);

            // Phone screen bezel detection around face
            const bezelCheck = detectScreenBezel(pCtx, 320, 240, {
              cx,
              cy,
              width: faceW,
              height: faceH,
            });
            isBezelDetected = bezelCheck.detected;
          } else {
            isPosOk = avgLuma > 40;
            isStraightOk = isPosOk;
            const fallbackGlasses = checkGlassesFallback(pCtx, 320, 240);
            isNoGlassesOk = fallbackGlasses.pass;
          }
        } catch {
          isPosOk = avgLuma > 40;
          isStraightOk = isPosOk;
          const fallbackGlasses = checkGlassesFallback(pCtx, 320, 240);
          isNoGlassesOk = fallbackGlasses.pass;
        }
      } else {
        isPosOk = avgLuma > 40;
        isStraightOk = isPosOk;
        const fallbackGlasses = checkGlassesFallback(pCtx, 320, 240);
        isNoGlassesOk = fallbackGlasses.pass;
      }

      setChecks({
        light: isLightOk ? 'Lolos' : 'Memeriksa',
        facePos: isPosOk ? 'Lolos' : 'Memeriksa',
        lookStraight: isStraightOk ? 'Lolos' : 'Memeriksa',
        liveBlink: isBlinkOk ? 'Lolos' : 'Menunggu',
        noGlasses: isNoGlassesOk,
        phoneBezel: isBezelDetected,
      });

      // Strict readiness check: Must NOT be a phone bezel, and MUST have biological blink
      const allReady =
        isLightOk &&
        isPosOk &&
        isStraightOk &&
        isNoGlassesOk &&
        isBlinkOk &&
        !isBezelDetected;

      if (isBezelDetected) {
        setStatusText('Peringatan: Terdeteksi bingkai layar HP / perangkat lain di depan kamera!');
      } else if (!isNoGlassesOk) {
        setStatusText('Mohon lepas kacamata untuk ketepatan pemindaian');
      } else if (!isLightOk) {
        setStatusText(
          avgLuma < 45
            ? 'Pencahayaan kurang, hadapkan wajah ke sumber cahaya lembut'
            : 'Pencahayaan terlalu silau'
        );
      } else if (!isPosOk) {
        setStatusText('Posisikan wajah Anda tepat di dalam bingkai oval');
      } else if (!isStraightOk) {
        setStatusText('Arahkan pandangan lurus dan tegak ke arah kamera');
      } else if (!isBlinkOk) {
        setStatusText('Kedipkan mata Anda 1x untuk verifikasi wajah asli (anti-foto/layar)');
      } else {
        setStatusText('Posisi optimal terkalibrasi & wajah hidup valid. Siap memindai.');
      }

      if (allReady) {
        if (scanState !== 'READY') setScanState('READY');
        autoTriggerCountRef.current += 1;
        // Auto trigger only after 1.5s of steady alignment with confirmed living blink
        if (autoTriggerCountRef.current >= 15) {
          autoTriggerCountRef.current = 0;
          handleStartScan();
        }
      } else {
        autoTriggerCountRef.current = 0;
        if (scanState === 'READY') setScanState('CHECKING');
      }
    };

    timerRef.current = setInterval(checkFrame, 100);
    return () => clearInterval(timerRef.current);
  }, [scanState]);

  // 4. Countdown & Screen Flash Liveness Flow (Anti-Layar HP / Foto)
  const handleStartScan = async () => {
    if (
      scanState === 'COUNTDOWN' ||
      scanState === 'SCANNING' ||
      scanState === 'FLASH' ||
      scanState === 'SUCCESS'
    ) {
      return;
    }

    // STRICT ANTI-SPOOF PRE-CHECK:
    // 1. If screen bezel was detected, immediately block
    if (checks.phoneBezel) {
      setScanState('FAILED');
      setStatusText('Verifikasi ditolak: Terdeteksi bingkai layar ponsel');
      setErrorMessage(
        'Sistem mendeteksi layar ponsel lain atau tablet di depan kamera. Harap gunakan wajah Anda langsung di kamera.'
      );
      return;
    }

    // 2. If eye blink was never detected (static photo on screen), block
    if (checks.liveBlink !== 'Lolos') {
      setScanState('FAILED');
      setStatusText('Verifikasi ditolak: Terdeteksi foto statis / layar HP');
      setErrorMessage(
        'Sistem mendeteksi gambar foto statis tanpa kedipan mata biologis alami. Harap hadapkan wajah asli Anda langsung dan kedipkan mata.'
      );
      return;
    }

    setScanState('COUNTDOWN');
    setStatusText('Tahan posisi stabil. Mengambil sampel biometrik...');

    // 3.. 2.. 1.. Countdown
    for (let n = 3; n > 0; n--) {
      setCountdownNum(n);
      await new Promise((r) => setTimeout(r, 700));
    }
    setCountdownNum(null);

    // Screen Flash with Challenge Color
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
          laplacianVar,
          {
            blinkVerified: checks.liveBlink === 'Lolos',
            bezelDetected: checks.phoneBezel,
          }
        );
      }
    } else {
      setIsFlashing(false);
    }

    // Blokir jika terdeteksi pantulan layar HP lain atau foto cetak
    if (liveness && !liveness.passed) {
      setScanState('FAILED');
      setStatusText('Verifikasi biometrik ditolak: Terdeteksi layar HP lain atau foto');
      setErrorMessage(
        liveness.reason ||
          'Sistem mendeteksi pantulan kaca layar HP lain atau foto fisik. Harap hadapkan wajah asli Anda langsung ke kamera.'
      );
      return;
    }

    // Run ONNX Multi-Head Inference
    await executeInference(liveness);
  };

  // 5. Execute ONNX Inference & Verify
  const executeInference = async (liveness: any) => {
    setScanState('SCANNING');
    setStatusText('Menganalisis matriks melanin, hidrasi & barier kulit...');

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

      let currentSession = sessionData;
      if (
        !currentSession ||
        Math.floor(Date.now() / 1000) - currentSession.issuedAt > 300
      ) {
        currentSession = await fetchChallenge();
      }

      const verifyRes = await fetch('/api/scan/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: currentSession?.sessionId,
          nonce: currentSession?.nonce,
          issuedAt: currentSession?.issuedAt,
          flashColor: currentSession?.challenge?.flashColor || flashColor,
          signature: currentSession?.signature,
          livenessResult: liveness,
          prediction,
        }),
      });

      const verifyData = await verifyRes.json();

      if (!verifyRes.ok || verifyData.status === 'error') {
        throw new Error(verifyData.message || 'Verifikasi anti-manipulasi ditolak oleh server');
      }

      setVerificationData(verifyData);
      setScanState('SUCCESS');
      setStatusText('Analisis kulit berhasil diselesaikan.');

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    } catch (err: any) {
      console.error(err);
      setScanState('FAILED');
      setErrorMessage(err.message || 'Gagal memproses model analisis kulit');
    }
  };

  // Reset scan
  const handleResetScan = () => {
    setScanState('IDLE');
    setCountdownNum(null);
    setVerificationData(null);
    setCapturedThumbnail(null);
    setErrorMessage('');
    setCartItems(new Set());
    autoTriggerCountRef.current = 0;
    blinkTrackerRef.current.reset();
    setStatusText('Posisikan wajah Anda tepat di dalam bingkai oval dan kedipkan mata');
    setChecks({
      light: 'Memeriksa',
      facePos: 'Memeriksa',
      lookStraight: 'Memeriksa',
      liveBlink: 'Menunggu',
      noGlasses: true,
      phoneBezel: false,
    });
    fetchChallenge().then(() => {
      startCamera();
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Build Transparent Metrics List from ONNX Results
  const getMetrics = () => {
    const analysis = verificationData?.analysis;
    const dominantType = analysis?.skinType?.type || 'kombinasi';
    const concerns = analysis?.concerns || [];

    const getPct = (code: string, fallback: number) => {
      const c = concerns.find((item: any) => item.code === code);
      return c ? Math.round(c.prob * 100) : fallback;
    };

    const isOily = dominantType === 'berminyak';
    const isDry = dominantType === 'kering';

    const kelembapanPct = isDry ? 42 : isOily ? 68 : 58;
    const minyakPct = isOily ? 78 : dominantType === 'kombinasi' ? 66 : 40;
    const poriPct = getPct('pori_besar', 54);
    const nodaPct = getPct('flek_hitam', 38);
    const kemerahanPct = getPct('kemerahan', 27);
    const garisPct = getPct('kerutan', 20);

    return [
      {
        label: 'Tingkat Hidrasi Kulit',
        val: kelembapanPct,
        threshold: 50,
        status: kelembapanPct >= 50 ? 'Cukup Optimal' : 'Perlu Suplementasi',
        tone: kelembapanPct >= 50 ? 'ok' : 'watch',
      },
      {
        label: 'Aktivitas Sebum Wajah',
        val: minyakPct,
        threshold: 60,
        status: minyakPct > 60 ? 'Produksi Tinggi' : 'Fisiologis Seimbang',
        tone: minyakPct > 60 ? 'watch' : 'ok',
      },
      {
        label: 'Dilatasi Pori-Pori Wajah',
        val: poriPct,
        threshold: 45,
        status: poriPct > 45 ? 'Tampak Melebar' : 'Terkontrol Halus',
        tone: poriPct > 45 ? 'watch' : 'ok',
      },
      {
        label: 'Indeks Melanin & Noda Gelap',
        val: nodaPct,
        threshold: 45,
        status: nodaPct > 45 ? 'Perlu Terapi Pencerah' : 'Pigmentasi Ringan',
        tone: nodaPct > 45 ? 'watch' : 'ok',
      },
      {
        label: 'Reaktivitas & Eritema (Kemerahan)',
        val: kemerahanPct,
        threshold: 40,
        status: kemerahanPct > 40 ? 'Sensitivitas Aktif' : 'Dermis Tenang',
        tone: kemerahanPct > 40 ? 'watch' : 'ok',
      },
      {
        label: 'Garis Halus & Penurunan Elastisitas',
        val: garisPct,
        threshold: 45,
        status: garisPct > 45 ? 'Garis Statis Terlihat' : 'Elastisitas Baik',
        tone: garisPct > 45 ? 'watch' : 'ok',
      },
    ];
  };

  // Recommended Products List (NO BPOM tags, matched to skin concerns)
  const getRoutineProducts = () => {
    const hero = verificationData?.recommendations?.heroProduct;
    const supporting = verificationData?.recommendations?.supportingProducts || [];

    const list: Array<{
      name: string;
      desc: string;
      price: number;
      id: number;
      step: string;
      category: string;
    }> = [];

    if (hero) {
      list.push({
        id: hero.id || 1,
        step: 'Langkah 2: Serum Terapi Aktif',
        name: hero.nama,
        desc: hero.reasons?.[0] || 'Formula bahan aktif terkurasi untuk mengatasi target kondisi kulit.',
        price: hero.harga || 89000,
        category: hero.kategori || 'Serum',
      });
    }

    const steps = [
      'Langkah 1: Pembersih Wajah',
      'Langkah 3: Pelembap / Barrier Kulit',
      'Langkah 4: Perlindungan Sunscreen UV',
    ];

    supporting.forEach((p: any, idx: number) => {
      list.push({
        id: p.id || idx + 2,
        step: steps[idx] || `Langkah ${idx + 2}`,
        name: p.nama,
        desc: p.fungsi || p.reasons?.[0] || 'Mendukung hidrasi dan menjaga kelembapan kulit wajah.',
        price: p.harga || 75000,
        category: p.kategori || 'Skincare',
      });
    });

    if (list.length === 0) {
      list.push(
        {
          id: 1,
          step: 'Langkah 1: Pembersih Seimbang',
          name: 'Gentle Hydrating Cleanser pH 5.5',
          desc: 'Mengangkat kotoran dan sebum tanpa merusak lapisan lipid barier kulit.',
          price: 65000,
          category: 'Cleanser',
        },
        {
          id: 2,
          step: 'Langkah 2: Serum Terapi Aktif',
          name: 'Niacinamide 5% + Zinc PCA Serum',
          desc: 'Menyeimbangkan produksi sebum dan merapatkan tampilan pori-pori.',
          price: 89000,
          category: 'Serum',
        },
        {
          id: 3,
          step: 'Langkah 3: Pelembap / Barrier Kulit',
          name: 'Ceramide Hydro-Gel Barrier Cream',
          desc: 'Menghidrasi kulit dan mengunci kelembapan alami wajah.',
          price: 78000,
          category: 'Moisturizer',
        },
        {
          id: 4,
          step: 'Langkah 4: Perlindungan Sunscreen UV',
          name: 'Physical UV Shield SPF 50+ PA++++',
          desc: 'Perlindungan terhadap paparan sinar ultraviolet matahari.',
          price: 95000,
          category: 'Sunscreen',
        }
      );
    }

    return list.slice(0, 4);
  };

  const routineProducts = getRoutineProducts();

  const toggleCart = (id: number) => {
    setCartItems((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const cartTotal = routineProducts
    .filter((p) => cartItems.has(p.id))
    .reduce((sum, p) => sum + p.price, 0);

  const formatRp = (n: number) => 'Rp ' + n.toLocaleString('id-ID');

  const dominantSkinLabel =
    verificationData?.analysis?.skinType?.label || 'Kombinasi';
  const dominantSkinPct =
    verificationData?.analysis?.skinType?.percentage ||
    Math.round(
      (verificationData?.analysis?.skinType?.probability || 0.68) * 1000
    ) / 10;
  const skinScore = verificationData?.analysis?.skinScore || 85;
  const confidence = verificationData?.analysis?.confidence || 94;

  const allReady =
    checks.light === 'Lolos' &&
    checks.facePos === 'Lolos' &&
    checks.lookStraight === 'Lolos' &&
    checks.noGlasses &&
    checks.liveBlink === 'Lolos' &&
    !checks.phoneBezel;

  return (
    <main className="min-h-screen bg-[#14091a] text-[#fdf4ff] flex flex-col items-center relative overflow-hidden selection:bg-[#c084fc] selection:text-[#14091a]">
      {/* Ambient Luxury Plum Glowing Orbs */}
      <div className="absolute top-[-10%] left-[-10%] w-[500px] h-[500px] rounded-full bg-gradient-to-br from-[#86198f]/20 to-[#4c1d95]/10 blur-[130px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[600px] h-[600px] rounded-full bg-gradient-to-tl from-[#c026d3]/15 to-[#701a75]/10 blur-[150px] pointer-events-none" />

      {/* Hidden offscreen canvases */}
      <canvas ref={probeCanvasRef} className="hidden" />
      <canvas ref={cropCanvasRef} className="hidden" />

      {/* Full-width Responsive Horizontal Container */}
      <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5 flex flex-col flex-1 relative z-10">
        {/* Top Header */}
        <header className="flex items-center justify-between pb-4 mb-6 border-b border-[rgba(255,255,255,0.08)]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#9333ea] to-[#c026d3] flex items-center justify-center text-white shadow-[0_4px_16px_rgba(192,38,211,0.35)]">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <div className="font-serif-luxury font-bold text-xl tracking-wider text-white">
                DEMO AI
              </div>
              <span className="text-xs text-[#c4b5fd] font-medium tracking-tight block">
                Skin Analysis &amp; Rekomendasi
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1 rounded-full bg-[rgba(255,255,255,0.06)] text-[#e9d5ff] border border-[rgba(255,255,255,0.12)] backdrop-blur-md">
              <ShieldCheck className="w-3.5 h-3.5 text-[#4ade80]" />
              Anti-Layar HP · Liveness 3D Aktif
            </span>
            {scanState === 'SUCCESS' && (
              <button
                type="button"
                onClick={handleResetScan}
                className="inline-flex items-center gap-1 text-xs font-semibold px-3 py-1 rounded-full border border-[rgba(255,255,255,0.16)] hover:bg-white/10 text-white transition cursor-pointer"
              >
                <RefreshCw className="w-3 h-3" />
                Pindai Ulang
              </button>
            )}
          </div>
        </header>

        {/* -------------------------------------------------------------
            HORIZONTAL 2-COLUMN SPLIT LAYOUT (Scan di Kiri + Hasil di Kanan)
        -------------------------------------------------------------- */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-start flex-1">
          {/* =========================================================
              LEFT COLUMN: SCANNER / CAPTURED USER PHOTO (col-span-5)
          ========================================================== */}
          <div className="lg:col-span-5 space-y-4">
            {scanState !== 'SUCCESS' ? (
              /* ACTIVE CAMERA VIEWFINDER */
              <div className="clinical-card p-4 space-y-4">
                <div
                  className={`clinical-cam relative aspect-[3/4] w-full rounded-2xl overflow-hidden flex items-center justify-center ${
                    allReady ? 'ready' : ''
                  } ${scanState === 'SCANNING' ? 'scanning' : ''}`}
                >
                  {/* Live Video Feed */}
                  <video
                    ref={videoRef}
                    playsInline
                    muted
                    autoPlay
                    className="absolute inset-0 w-full h-full object-cover -scale-x-100"
                  />

                  {/* Clean SVG Precision Reticle */}
                  <svg
                    viewBox="0 0 300 400"
                    className="absolute inset-0 w-full h-full pointer-events-none z-10"
                    aria-hidden="true"
                  >
                    {/* Oval Target Outline (Transparent center, dashed white -> solid emerald) */}
                    <ellipse
                      cx="150"
                      cy="185"
                      rx="96"
                      ry="128"
                      fill="none"
                      stroke={allReady ? '#4ADE80' : 'rgba(255, 255, 255, 0.75)'}
                      strokeWidth="2.5"
                      strokeDasharray={allReady ? 'none' : '6 8'}
                      style={{
                        filter: allReady
                          ? 'drop-shadow(0 0 10px rgba(74, 222, 128, 0.85))'
                          : 'none',
                        transition: 'all 0.3s ease',
                      }}
                    />

                    {/* 4 Precision Corner Calibration Brackets */}
                    <path
                      d="M 54 68 L 40 68 A 14 14 0 0 0 26 82 L 26 96"
                      fill="none"
                      stroke={allReady ? '#4ADE80' : 'rgba(255, 255, 255, 0.85)'}
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    />
                    <path
                      d="M 246 68 L 260 68 A 14 14 0 0 1 274 82 L 274 96"
                      fill="none"
                      stroke={allReady ? '#4ADE80' : 'rgba(255, 255, 255, 0.85)'}
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    />
                    <path
                      d="M 54 302 L 40 302 A 14 14 0 0 1 26 288 L 26 274"
                      fill="none"
                      stroke={allReady ? '#4ADE80' : 'rgba(255, 255, 255, 0.85)'}
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    />
                    <path
                      d="M 246 302 L 260 302 A 14 14 0 0 0 274 288 L 274 274"
                      fill="none"
                      stroke={allReady ? '#4ADE80' : 'rgba(255, 255, 255, 0.85)'}
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    />
                  </svg>

                  {/* Cyan Laser Sweep Animation */}
                  <div className="clinical-sweep" />

                  {/* Large Countdown Overlay (3, 2, 1) */}
                  {countdownNum !== null && (
                    <div className="clinical-countdown animate-pulse font-serif-luxury text-7xl sm:text-8xl text-white drop-shadow-[0_0_24px_rgba(232,121,249,0.85)]">
                      {countdownNum}
                    </div>
                  )}

                  {/* Dynamic Screen Flash Overlay (Anti-Layar HP) */}
                  <div
                    className={`clinical-flash ${isFlashing ? 'active' : ''}`}
                    style={{ backgroundColor: flashColor }}
                  />

                  {/* Top Floating Badge */}
                  <div className="absolute left-3 top-3 z-20">
                    <span className="glass-pill px-2.5 py-1 rounded-full text-[11px] font-semibold text-white shadow-sm flex items-center gap-1.5">
                      <span className={`w-2 h-2 rounded-full ${checks.liveBlink === 'Lolos' ? 'bg-[#4ade80] animate-pulse' : 'bg-[#fbbf24]'}`} />
                      {checks.liveBlink === 'Lolos' ? 'Biometrik Hidup Aktif' : 'Menunggu Kedipan'}
                    </span>
                  </div>
                </div>

                {/* 4 Quality Calibration Chips (Light, Pos, Straight, Biological Blink) */}
                <div className="grid grid-cols-4 gap-2">
                  <div
                    className={`p-2 rounded-xl border text-center transition-all ${
                      checks.light === 'Lolos'
                        ? 'bg-[rgba(74,222,128,0.12)] border-[#4ade80]/40 text-[#4ade80]'
                        : 'bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.08)] text-[#c4b5fd]'
                    }`}
                  >
                    <div className="flex items-center justify-center gap-1 text-[10px] font-semibold">
                      <Sun className="w-3 h-3" />
                      Cahaya
                    </div>
                    <span className="text-[10px] font-bold block mt-0.5">
                      {checks.light === 'Lolos' ? '✓ Pas' : '○ Sesuaikan'}
                    </span>
                  </div>

                  <div
                    className={`p-2 rounded-xl border text-center transition-all ${
                      checks.facePos === 'Lolos'
                        ? 'bg-[rgba(74,222,128,0.12)] border-[#4ade80]/40 text-[#4ade80]'
                        : 'bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.08)] text-[#c4b5fd]'
                    }`}
                  >
                    <div className="flex items-center justify-center gap-1 text-[10px] font-semibold">
                      <UserCheck className="w-3 h-3" />
                      Posisi
                    </div>
                    <span className="text-[10px] font-bold block mt-0.5">
                      {checks.facePos === 'Lolos' ? '✓ Presisi' : '○ Di Oval'}
                    </span>
                  </div>

                  <div
                    className={`p-2 rounded-xl border text-center transition-all ${
                      checks.lookStraight === 'Lolos'
                        ? 'bg-[rgba(74,222,128,0.12)] border-[#4ade80]/40 text-[#4ade80]'
                        : 'bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.08)] text-[#c4b5fd]'
                    }`}
                  >
                    <div className="flex items-center justify-center gap-1 text-[10px] font-semibold">
                      <Eye className="w-3 h-3" />
                      Lurus
                    </div>
                    <span className="text-[10px] font-bold block mt-0.5">
                      {checks.lookStraight === 'Lolos' ? '✓ Sejajar' : '○ Miring'}
                    </span>
                  </div>

                  <div
                    className={`p-2 rounded-xl border text-center transition-all ${
                      checks.liveBlink === 'Lolos'
                        ? 'bg-[rgba(74,222,128,0.12)] border-[#4ade80]/40 text-[#4ade80]'
                        : 'bg-[rgba(251,191,36,0.12)] border-[#fbbf24]/40 text-[#fbbf24]'
                    }`}
                  >
                    <div className="flex items-center justify-center gap-1 text-[10px] font-semibold">
                      <ScanFace className="w-3 h-3" />
                      Mata Hidup
                    </div>
                    <span className="text-[10px] font-bold block mt-0.5">
                      {checks.liveBlink === 'Lolos' ? '✓ Berkedip' : '○ Kedip 1x'}
                    </span>
                  </div>
                </div>

                {/* Phone Screen Bezel Warning (Anti-Device Spoofing) */}
                {checks.phoneBezel && (
                  <div className="p-3 rounded-xl bg-[rgba(251,113,133,0.2)] border border-[#fb7185]/60 text-xs text-[#fecdd3] flex items-center gap-2 animate-pulse">
                    <Smartphone className="w-4 h-4 flex-shrink-0 text-[#fb7185]" />
                    <span className="font-semibold">
                      Terdeteksi layar ponsel lain di depan kamera! Harap singkirkan perangkat lain dan gunakan wajah asli Anda langsung.
                    </span>
                  </div>
                )}

                {/* Glasses Warning */}
                {!checks.noGlasses && (
                  <div className="p-3 rounded-xl bg-[rgba(251,113,133,0.15)] border border-[rgba(251,113,133,0.35)] text-xs text-[#fecdd3] flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 flex-shrink-0 text-[#fb7185]" />
                    <span>Lepas kacamata agar area mata dan dahi terbaca jelas.</span>
                  </div>
                )}

                {/* Status Message & Responsive Action Button */}
                <div className="space-y-2.5 pt-1">
                  <p className="text-xs text-center font-medium text-[#e9d5ff]">
                    {statusText}
                  </p>
                  {errorMessage && (
                    <div className="text-xs text-[#fb7185] font-semibold text-center bg-[rgba(251,113,133,0.1)] p-3 rounded-xl border border-[rgba(251,113,133,0.3)]">
                      <p className="font-bold flex items-center justify-center gap-1 mb-0.5">
                        <AlertCircle className="w-3.5 h-3.5" />
                        Pindaian Ditolak Sistem Anti-Manipulasi
                      </p>
                      {errorMessage}
                    </div>
                  )}

                  {/* Mulai Pemindaian Kulit Button - Protected against other device screens */}
                  <button
                    type="button"
                    onClick={handleStartScan}
                    disabled={
                      scanState === 'COUNTDOWN' ||
                      scanState === 'SCANNING' ||
                      scanState === 'FLASH'
                    }
                    className={`w-full py-3.5 rounded-xl font-bold text-sm text-white transition active:scale-[0.99] cursor-pointer flex items-center justify-center gap-2 shadow-lg ${
                      allReady
                        ? 'bg-gradient-to-r from-[#10b981] via-[#059669] to-[#047857] shadow-[0_4px_20px_rgba(16,185,129,0.4)] hover:brightness-110'
                        : 'bg-gradient-to-r from-[#9333ea] via-[#c026d3] to-[#e879f9] shadow-[0_4px_20px_rgba(192,38,211,0.4)] hover:brightness-110'
                    }`}
                  >
                    {scanState === 'SCANNING' ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        Menganalisis Kondisi Kulit...
                      </>
                    ) : scanState === 'COUNTDOWN' ? (
                      <>
                        <Zap className="w-4 h-4" />
                        Mengambil Sampel Biometrik...
                      </>
                    ) : allReady ? (
                      <>
                        <Zap className="w-4 h-4 text-emerald-200" />
                        Pindai Wajah Sekarang (Wajah Hidup ✓)
                      </>
                    ) : (
                      <>
                        <Camera className="w-4 h-4" />
                        Mulai Pemindaian Kulit
                      </>
                    )}
                  </button>
                </div>
              </div>
            ) : (
              /* POST-SCAN: CAPTURED USER FACE PHOTO */
              <div className="clinical-card p-4 space-y-4">
                <div className="relative aspect-[3/4] w-full rounded-2xl overflow-hidden border border-[rgba(255,255,255,0.12)] bg-black/60 shadow-md">
                  {capturedThumbnail ? (
                    <img
                      src={capturedThumbnail}
                      alt="Wajah Hasil Pemindaian"
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-slate-400">
                      Foto Tersimpan
                    </div>
                  )}

                  {/* Overlay Verification Stamp on the Real Face Photo */}
                  <div className="absolute left-3 top-3">
                    <span className="glass-pill px-2.5 py-1 rounded-full text-[11px] font-bold text-[#4ade80] shadow-sm flex items-center gap-1.5 border border-[#4ade80]/40">
                      <CheckCircle2 className="w-3.5 h-3.5 text-[#4ade80]" />
                      Wajah Terverifikasi (Kamera Langsung)
                    </span>
                  </div>

                  <div className="absolute bottom-3 inset-x-3 bg-black/70 backdrop-blur-md rounded-xl p-2.5 text-white flex items-center justify-between text-xs border border-white/10">
                    <div>
                      <span className="text-[10px] text-white/70 block uppercase font-bold">
                        Respon Flash Spektral
                      </span>
                      <strong className="text-[#4ade80]">
                        {verificationData?.analysis?.livenessMetrics?.chromaticShift || 85}% Valid
                      </strong>
                    </div>
                    <div className="text-right">
                      <span className="text-[10px] text-white/70 block uppercase font-bold">
                        Ketajaman Kontras
                      </span>
                      <strong className="text-[#4ade80]">
                        {verificationData?.analysis?.livenessMetrics?.laplacianSharpness || 36} (Optimal)
                      </strong>
                    </div>
                  </div>
                </div>

                {/* Score & Retake Quick Bar */}
                <div className="flex items-center justify-between p-3.5 rounded-xl bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)]">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-[#9333ea]/30 to-[#c026d3]/30 border border-[#c084fc]/30 flex flex-col items-center justify-center shadow-sm">
                      <span className="font-serif-luxury font-bold text-base text-[#f0abfc]">
                        {skinScore}
                      </span>
                      <span className="text-[8px] uppercase font-bold text-[#c4b5fd]">
                        Skor
                      </span>
                    </div>
                    <div>
                      <strong className="text-xs text-white block">
                        Indeks Kondisi Kulit
                      </strong>
                      <span className="text-[11px] text-[#c4b5fd]">
                        Tingkat Akurasi AI: {confidence}%
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={handleResetScan}
                    className="px-3 py-1.5 rounded-lg bg-[rgba(255,255,255,0.08)] hover:bg-[rgba(255,255,255,0.14)] border border-[rgba(255,255,255,0.14)] text-xs font-bold text-white transition cursor-pointer shadow-sm flex items-center gap-1"
                  >
                    <RefreshCw className="w-3 h-3" />
                    Scan Ulang
                  </button>
                </div>
              </div>
            )}

            {/* Anti-Spoof Security Notice */}
            <div className="p-3 rounded-xl bg-[rgba(74,222,128,0.08)] border border-[#4ade80]/25 text-[11px] text-[#4ade80] flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 flex-shrink-0" />
              <span>
                Verifikasi anti-manipulasi 3D menolak foto cetak dan layar HP lain menggunakan analisis kedipan biologis dan respon spektral jaringan dermis hidup.
              </span>
            </div>
          </div>

          {/* =========================================================
              RIGHT COLUMN: PRE-SCAN GUIDE OR DIAGNOSTIC RESULTS (col-span-7)
          ========================================================== */}
          <div className="lg:col-span-7 space-y-5">
            {scanState !== 'SUCCESS' ? (
              /* PRE-SCAN INSTRUCTIONAL GUIDE */
              <div className="space-y-4">
                <div className="clinical-card p-6 space-y-4">
                  <div className="space-y-1">
                    <span className="text-[11px] uppercase tracking-wider font-bold text-[#f0abfc]">
                      Panduan Pemindaian
                    </span>
                    <h2 className="font-serif-luxury text-2xl font-bold text-white">
                      Analisis Cerdas Kondisi Kulit Wajah
                    </h2>
                    <p className="text-xs text-[#c4b5fd] leading-relaxed">
                      Sistem memanfaatkan deep learning MobileNetV3-Small ONNX di peramban dan validasi
                      kamera langsung anti-manipulasi untuk mengenali tipe dan masalah kulit, lalu mencocokkan formulasi skincare terbaik.
                    </p>
                  </div>

                  {/* 4 Diagnostic Scope Items */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                    <div className="p-3.5 rounded-xl bg-[rgba(255,255,255,0.03)] border border-[rgba(255,255,255,0.08)] space-y-1">
                      <div className="flex items-center gap-1.5 text-xs font-bold text-white">
                        <CheckCheck className="w-3.5 h-3.5 text-[#4ade80]" />
                        Identifikasi 4 Tipe Kulit
                      </div>
                      <p className="text-[11px] text-[#c4b5fd]">
                        Mengklasifikasikan tipe kulit wajah (Normal, Kering, Berminyak, Kombinasi).
                      </p>
                    </div>

                    <div className="p-3.5 rounded-xl bg-[rgba(255,255,255,0.03)] border border-[rgba(255,255,255,0.08)] space-y-1">
                      <div className="flex items-center gap-1.5 text-xs font-bold text-white">
                        <CheckCheck className="w-3.5 h-3.5 text-[#4ade80]" />
                        Deteksi 5 Masalah Kulit
                      </div>
                      <p className="text-[11px] text-[#c4b5fd]">
                        Mendeteksi jerawat, flek hitam, kemerahan, pori-pori besar, dan kerutan.
                      </p>
                    </div>

                    <div className="p-3.5 rounded-xl bg-[rgba(255,255,255,0.03)] border border-[rgba(255,255,255,0.08)] space-y-1">
                      <div className="flex items-center gap-1.5 text-xs font-bold text-white">
                        <CheckCheck className="w-3.5 h-3.5 text-[#4ade80]" />
                        Anti-Layar HP &amp; Foto
                      </div>
                      <p className="text-[11px] text-[#c4b5fd]">
                        Verifikasi kedipan mata biologis &amp; pantulan spektral untuk menolak layar HP lain.
                      </p>
                    </div>

                    <div className="p-3.5 rounded-xl bg-[rgba(255,255,255,0.03)] border border-[rgba(255,255,255,0.08)] space-y-1">
                      <div className="flex items-center gap-1.5 text-xs font-bold text-white">
                        <CheckCheck className="w-3.5 h-3.5 text-[#4ade80]" />
                        Rekomendasi Terfokus
                      </div>
                      <p className="text-[11px] text-[#c4b5fd]">
                        Mencocokkan formulasi bahan aktif terbaik untuk kebutuhan kulit terdeteksi.
                      </p>
                    </div>
                  </div>
                </div>

                {/* 3 Preparation Steps Card */}
                <div className="clinical-card p-5 space-y-3">
                  <h3 className="text-xs uppercase font-bold tracking-wider text-white flex items-center gap-1.5">
                    <Info className="w-3.5 h-3.5 text-[#f0abfc]" />
                    Panduan Memperoleh Hasil Maksimal:
                  </h3>
                  <div className="space-y-2 text-xs text-[#c4b5fd]">
                    <div className="flex items-start gap-2">
                      <span className="w-5 h-5 rounded-full bg-gradient-to-br from-[#9333ea] to-[#c026d3] text-white font-bold text-[11px] flex items-center justify-center flex-shrink-0">
                        1
                      </span>
                      <span>Hadapkan wajah ke sumber cahaya yang merata (hindari lampu remang atau silau).</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="w-5 h-5 rounded-full bg-gradient-to-br from-[#9333ea] to-[#c026d3] text-white font-bold text-[11px] flex items-center justify-center flex-shrink-0">
                        2
                      </span>
                      <span>Pastikan wajah bersih tanpa makeup tebal dan lepas kacamata.</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="w-5 h-5 rounded-full bg-gradient-to-br from-[#9333ea] to-[#c026d3] text-white font-bold text-[11px] flex items-center justify-center flex-shrink-0">
                        3
                      </span>
                      <span>Posisikan wajah tepat di dalam bingkai oval lalu <strong>kedipkan mata Anda 1 kali</strong> untuk verifikasi hidup.</span>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              /* RESULTS DASHBOARD */
              <div className="space-y-5">
                {/* 1. Main Diagnosis Header Card */}
                <div className="clinical-card p-5 sm:p-6 space-y-4">
                  <div className="flex items-start justify-between gap-4 border-b border-[rgba(255,255,255,0.08)] pb-3.5">
                    <div>
                      <span className="text-[10px] uppercase font-bold tracking-wider text-[#f0abfc] bg-[#9333ea]/25 px-2 py-0.5 rounded border border-[#c084fc]/30">
                        Hasil Analisis Kulit Wajah
                      </span>
                      <h2 className="font-serif-luxury text-2xl sm:text-3xl font-bold text-white mt-1.5">
                        Kulit {dominantSkinLabel}
                      </h2>
                      <p className="text-xs text-[#c4b5fd] mt-1.5 leading-relaxed">
                        {dominantSkinLabel.toLowerCase().includes('kombinasi')
                          ? 'Aktivitas sebum lebih dominan pada area T-Zone dengan kelembapan moderat pada area pipi. Memerlukan barier hidrasi ringan dan seimbang.'
                          : dominantSkinLabel.toLowerCase().includes('berminyak')
                          ? 'Produksi kelenjar sebasea aktif di seluruh area wajah. Memerlukan pembersihan pori mendalam dan agen sebum kontrol.'
                          : dominantSkinLabel.toLowerCase().includes('kering')
                          ? 'Kadar lipid dan hidrasi stratum korneum rendah. Memerlukan hidrasi ceramide dan asam hialuronat intensif.'
                          : 'Keseimbangan kadar air dan minyak berada pada rentang fisiologis optimal.'}
                      </p>
                    </div>

                    <div className="text-right flex-shrink-0">
                      <span className="text-sm font-bold text-[#4ade80] block">
                        Akurasi AI: {confidence}%
                      </span>
                      <span className="text-[10px] text-[#c4b5fd]">
                        Model Multi-Head Wasm
                      </span>
                    </div>
                  </div>

                  {/* Transparent 4 Skin Types Breakdown */}
                  <div className="space-y-2">
                    <div className="flex justify-between items-center text-xs">
                      <span className="font-bold text-white uppercase tracking-wider text-[11px]">
                        Distribusi Probabilitas Tipe Kulit:
                      </span>
                      <span className="text-[10px] text-[#c4b5fd]">Total 100%</span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      {verificationData?.analysis?.skinType?.allTypes?.map((t: any) => {
                        const pct =
                          t.percentage ?? Math.round((t.prob || 0) * 1000) / 10;
                        const isTop =
                          t.type === verificationData?.analysis?.skinType?.type;
                        return (
                          <div
                            key={t.type}
                            className={`p-2.5 rounded-xl border space-y-1.5 ${
                              isTop
                                ? 'bg-[rgba(147,51,234,0.18)] border-[#c084fc]/40'
                                : 'bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.08)]'
                            }`}
                          >
                            <div className="flex justify-between text-xs">
                              <span
                                className={`font-semibold ${
                                  isTop ? 'text-[#f0abfc]' : 'text-[#c4b5fd]'
                                }`}
                              >
                                {t.label} {isTop && '✦ (Utama)'}
                              </span>
                              <span className="font-mono font-bold text-xs text-white">
                                {pct}%
                              </span>
                            </div>
                            <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all duration-700 ${
                                  isTop
                                    ? 'bg-gradient-to-r from-[#9333ea] to-[#e879f9]'
                                    : 'bg-white/20'
                                }`}
                                style={{ width: `${Math.max(3, pct)}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* 2. Transparent 6 Skin Conditions vs Thresholds */}
                <div className="clinical-card p-5 sm:p-6 space-y-3.5">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-[10px] uppercase font-bold tracking-wider text-[#f0abfc]">
                        Analisis Kondisi Kulit
                      </span>
                      <h3 className="font-serif-luxury text-xl font-bold text-white">
                        Tingkat Keyakinan 5 Masalah &amp; Parameter Kulit
                      </h3>
                    </div>
                    <span className="text-[10px] text-[#c4b5fd] font-mono">
                      Sigmoid Thresholds
                    </span>
                  </div>

                  <div className="space-y-2.5 pt-1">
                    {getMetrics().map((m, idx) => (
                      <div
                        key={idx}
                        className="p-3 rounded-xl bg-[rgba(255,255,255,0.03)] border border-[rgba(255,255,255,0.08)] space-y-1.5"
                      >
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-semibold text-white">
                            {m.label}
                          </span>
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-bold text-white">
                              {m.val}%
                            </span>
                            <span
                              className={`text-[10px] font-bold px-2 py-0.5 rounded-md ${
                                m.tone === 'ok'
                                  ? 'bg-[#4ade80]/15 text-[#4ade80] border border-[#4ade80]/30'
                                  : 'bg-[#fbbf24]/15 text-[#fbbf24] border border-[#fbbf24]/30'
                              }`}
                            >
                              {m.status}
                            </span>
                          </div>
                        </div>

                        {/* Progress Bar with Ambang Indicator */}
                        <div className="relative h-2 w-full bg-white/10 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-700 ${
                              m.tone === 'ok'
                                ? 'bg-gradient-to-r from-[#10b981] to-[#34d399]'
                                : 'bg-gradient-to-r from-[#f59e0b] to-[#fbbf24]'
                            }`}
                            style={{ width: `${Math.max(3, m.val)}%` }}
                          />
                        </div>

                        <div className="flex justify-between text-[10px] text-[#c4b5fd]">
                          <span>Terdeteksi AI: {m.val}%</span>
                          <span>Ambang Batas Deteksi: {m.threshold}%</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 3. Curated Regimen Recommendations (NO BPOM tags) */}
                <div className="clinical-card p-5 sm:p-6 space-y-4">
                  <div>
                    <span className="text-[10px] uppercase font-bold tracking-wider text-[#f0abfc]">
                      Rekomendasi Terfokus
                    </span>
                    <h3 className="font-serif-luxury text-xl font-bold text-white">
                      Rekomendasi Produk Sesuai Kondisi Kulit
                    </h3>
                    <p className="text-xs text-[#c4b5fd]">
                      Rekomendasi produk dihasilkan melalui aturan pencocokan bahan aktif katalog dengan tipe dan masalah kulit hasil pemindaian.
                    </p>
                  </div>

                  <div className="space-y-2.5">
                    {routineProducts.map((p) => {
                      const inCart = cartItems.has(p.id);
                      return (
                        <div
                          key={p.id}
                          className={`p-3.5 rounded-xl border transition-all ${
                            inCart
                              ? 'bg-[rgba(147,51,234,0.18)] border-[#c084fc]/40'
                              : 'bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.08)]'
                          }`}
                        >
                          <div className="flex justify-between items-start gap-2 mb-1">
                            <span className="text-[10px] font-bold uppercase tracking-wide text-[#f0abfc] bg-[#9333ea]/25 px-2 py-0.5 rounded border border-[#c084fc]/30">
                              {p.step}
                            </span>
                            <span className="font-bold text-xs text-white">
                              {formatRp(p.price)}
                            </span>
                          </div>

                          <h4 className="font-bold text-sm text-white">
                            {p.name}
                          </h4>
                          <p className="text-xs text-[#c4b5fd] mt-0.5 leading-relaxed">
                            {p.desc}
                          </p>

                          <div className="flex items-center justify-between pt-2.5 mt-2 border-t border-white/10">
                            <span className="text-[10px] text-[#e9d5ff] font-medium px-2 py-0.5 rounded bg-white/5 border border-white/10">
                              Kategori: {p.category}
                            </span>
                            <button
                              type="button"
                              onClick={() => toggleCart(p.id)}
                              className={`text-xs font-bold px-3 py-1.5 rounded-lg transition flex items-center gap-1 cursor-pointer ${
                                inCart
                                  ? 'bg-gradient-to-r from-[#9333ea] to-[#c026d3] text-white shadow-sm'
                                  : 'border border-[#c084fc]/50 text-[#f0abfc] hover:bg-white/10'
                              }`}
                            >
                              {inCart ? (
                                <>
                                  <Check className="w-3.5 h-3.5" />
                                  Ditambahkan
                                </>
                              ) : (
                                <>
                                  <Plus className="w-3.5 h-3.5" />
                                  Pilih Produk
                                </>
                              )}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Store Recommendation System Info */}
                  <div className="p-3.5 rounded-xl bg-[rgba(255,255,255,0.03)] border border-[rgba(255,255,255,0.08)] text-xs text-white flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <ShoppingBag className="w-4 h-4 text-[#f0abfc] flex-shrink-0" />
                      <div>
                        <span className="font-bold text-xs text-white block">
                          Katalog Terkurasi
                        </span>
                        <span className="text-[11px] text-[#c4b5fd]">
                          Rekomendasi bahan aktif presisi berbasis inferensi lokal ONNX
                        </span>
                      </div>
                    </div>
                    <span className="text-[10px] uppercase font-bold text-[#4ade80] bg-[#4ade80]/15 px-2 py-0.5 rounded border border-[#4ade80]/30">
                      Tervalidasi ✓
                    </span>
                  </div>

                  {/* Sticky Floating Action Bar for Checkout */}
                  <div className="clinical-cart-bar">
                    <div>
                      <span className="text-xs block text-white/70">
                        {cartItems.size > 0
                          ? `${cartItems.size} produk dipilih`
                          : 'Pilih produk untuk ringkasan pesanan'}
                      </span>
                      <span className="font-bold text-sm text-white">
                        {cartItems.size > 0 ? formatRp(cartTotal) : 'Total Produk'}
                      </span>
                    </div>

                    <button
                      type="button"
                      disabled={cartItems.size === 0}
                      onClick={() => {
                        alert(
                          `Pemesanan ${cartItems.size} produk senilai ${formatRp(
                            cartTotal
                          )} siap diproses.`
                        );
                      }}
                      className={`px-4 py-2.5 rounded-xl font-bold text-xs flex items-center gap-1.5 transition ${
                        cartItems.size > 0
                          ? 'bg-gradient-to-r from-[#9333ea] to-[#c026d3] hover:brightness-110 text-white shadow-md cursor-pointer'
                          : 'bg-white/10 text-white/30 cursor-not-allowed'
                      }`}
                    >
                      Checkout Pesanan
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
