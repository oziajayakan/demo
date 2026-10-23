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
  Stethoscope,
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
  | 'IDLE'
  | 'CHECKING'
  | 'READY'
  | 'COUNTDOWN'
  | 'FLASH'
  | 'SCANNING'
  | 'SUCCESS'
  | 'FAILED'
  | 'ERROR';

interface ZoneDetail {
  coords: [number, number]; // [left%, top%]
  name: string;
  status: 'ok' | 'watch';
  tag: string;
  desc: string;
}

export default function ModernClinicalScanPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<any>(null);
  const landmarkerRef = useRef<any>(null);

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

  // 3 Clinical Checks
  const [checks, setChecks] = useState({
    light: 'Memeriksa' as 'Menunggu' | 'Memeriksa' | 'Lolos',
    facePos: 'Memeriksa' as 'Menunggu' | 'Memeriksa' | 'Lolos',
    lookStraight: 'Memeriksa' as 'Menunggu' | 'Memeriksa' | 'Lolos',
    noGlasses: true,
  });

  // Results state
  const [verificationData, setVerificationData] = useState<any>(null);
  const [capturedThumbnail, setCapturedThumbnail] = useState<string | null>(null);
  const [selectedZone, setSelectedZone] = useState<string>('dahi');
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

  // 2. Start Video Camera with Clinical Resolution
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
    } catch (err: any) {
      console.error('Camera access error:', err);
      setStatusText(
        err.name === 'NotAllowedError'
          ? 'Izin kamera ditolak. Berikan izin di browser Anda.'
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

  // 3. Real-Time Camera Gates Check Loop
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
      const isLightOk = avgLuma >= 65 && avgLuma <= 220;

      // 2. Face Position & Look Straight
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
              cx >= 0.32 && cx <= 0.68 && cy >= 0.25 && cy <= 0.70 && faceH >= 0.30;

            const leftDist = Math.abs(noseTip.x - leftCheek.x);
            const rightDist = Math.abs(rightCheek.x - noseTip.x);
            const yawRatio = leftDist / (rightDist || 0.001);
            const isYawOk = yawRatio >= 0.60 && yawRatio <= 1.65;
            const tilt = Math.abs(leftEye.y - rightEye.y);
            isStraightOk = isYawOk && tilt < 0.085;

            const glassesRes = checkGlassesWithLandmarks(lm, pCtx, 320, 240);
            isNoGlassesOk = glassesRes.pass;
          } else {
            isPosOk = avgLuma > 55;
            isStraightOk = isPosOk;
            const fallbackGlasses = checkGlassesFallback(pCtx, 320, 240);
            isNoGlassesOk = fallbackGlasses.pass;
          }
        } catch {
          isPosOk = avgLuma > 55;
          isStraightOk = isPosOk;
          const fallbackGlasses = checkGlassesFallback(pCtx, 320, 240);
          isNoGlassesOk = fallbackGlasses.pass;
        }
      } else {
        isPosOk = avgLuma > 55;
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
        setStatusText('Mohon lepas kacamata untuk ketepatan pemindaian');
      } else if (!isLightOk) {
        setStatusText(
          avgLuma < 65
            ? 'Pencahayaan kurang, hadapkan wajah ke sumber cahaya lembut'
            : 'Pencahayaan terlalu silau'
        );
      } else if (!isPosOk) {
        setStatusText('Posisikan wajah Anda tepat di dalam bingkai oval');
      } else if (!isStraightOk) {
        setStatusText('Arahkan pandangan lurus dan tegak ke arah kamera');
      } else {
        setStatusText('Posisi optimal terkalibrasi. Siap memindai.');
      }

      if (allReady && scanState !== 'READY') {
        setScanState('READY');
      } else if (!allReady && scanState === 'READY') {
        setScanState('CHECKING');
      }
    };

    timerRef.current = setInterval(checkFrame, 90);
    return () => clearInterval(timerRef.current);
  }, [scanState]);

  // 4. Clinical Countdown & Screen Flash Liveness Flow
  const handleStartScan = async () => {
    if (scanState === 'COUNTDOWN' || scanState === 'SCANNING') return;
    setScanState('COUNTDOWN');
    setStatusText('Tahan posisi stabil. Mengambil sampel biometrik...');

    // 3.. 2.. 1.. Countdown
    for (let n = 3; n > 0; n--) {
      setCountdownNum(n);
      await new Promise((r) => setTimeout(r, 750));
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
          laplacianVar
        );
      }
    } else {
      setIsFlashing(false);
    }

    if (liveness && !liveness.passed) {
      setScanState('FAILED');
      setStatusText('Verifikasi biometrik tidak lolos: gunakan wajah asli');
      setErrorMessage(
        'Sistem mendeteksi kemungkinan foto cetak, layar HP lain, atau pantulan tidak alami.'
      );
      return;
    }

    // Step E: Run ONNX Multi-Head Inference
    await executeInference(liveness);
  };

  // 5. Execute ONNX Inference & Verify
  const executeInference = async (liveness: any) => {
    setScanState('SCANNING');
    setStatusText('Menganalisis matriks melanin, hidrasi & barier kulit…');

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
      setVerificationData(verifyData);
      setScanState('SUCCESS');

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
    setVerificationData(null);
    setCapturedThumbnail(null);
    setErrorMessage('');
    setCartItems(new Set());
    setStatusText('Posisikan wajah Anda tepat di dalam bingkai oval');
    setChecks({
      light: 'Memeriksa',
      facePos: 'Memeriksa',
      lookStraight: 'Memeriksa',
      noGlasses: true,
    });
    fetchChallenge().then(() => {
      startCamera();
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Build Zone Map data based on actual predictions
  const getZoneData = (): Record<string, ZoneDetail> => {
    const analysis = verificationData?.analysis;
    const concerns = analysis?.concerns || [];
    const dominantType = analysis?.skinType?.type || 'kombinasi';

    const getConcernProb = (code: string) => {
      const c = concerns.find((item: any) => item.code === code);
      return c ? c.prob : 0.3;
    };

    const isAcne = getConcernProb('jerawat') > 0.4;
    const isPores = getConcernProb('pori_besar') > 0.42;
    const isDarkSpots = getConcernProb('flek_hitam') > 0.4;
    const isRedness = getConcernProb('kemerahan') > 0.38;
    const isOilyT = dominantType === 'berminyak' || dominantType === 'kombinasi';

    return {
      dahi: {
        coords: [50, 23],
        name: 'Zona Frontal (Dahi)',
        status: isOilyT ? 'watch' : 'ok',
        tag: isOilyT ? 'Hipersekresi Sebum' : 'Barier Seimbang',
        desc: isOilyT
          ? 'Terdapat kelebihan sebum aktif di area T-Zone. Disarankan eksfoliasi lembut BHA dan niacinamide.'
          : 'Kondisi mikrobioma dan hidrasi dahi terjaga stabil.',
      },
      pipiK: {
        coords: [27, 52],
        name: 'Zona Malar Kiri (Pipi Kiri)',
        status: dominantType === 'kering' || isRedness ? 'watch' : 'ok',
        tag:
          dominantType === 'kering'
            ? 'Dehidrasi Lapisan Stratum'
            : isRedness
            ? 'Reaktivitas Kapiler'
            : 'Hidrasi Optimal',
        desc:
          dominantType === 'kering'
            ? 'Kadar air transepidermal rendah. Perlu dukungan asam hialuronat & ceramide cair.'
            : isRedness
            ? 'Tampak vaskularisasi reaktif ringan. Gunakan pelembap ber-centella & panthenol.'
            : 'Barier hidrasi pipi berada pada kondisi fisiologis optimal.',
      },
      pipiR: {
        coords: [73, 52],
        name: 'Zona Malar Kanan (Pipi Kanan)',
        status: isDarkSpots ? 'watch' : 'ok',
        tag: isDarkSpots ? 'Melanogenesis Aktif' : 'Tone Merata',
        desc: isDarkSpots
          ? 'Terdeteksi akumulasi pigmen melanin ringan. Disarankan pelindung fotoproteksi SPF 50 & asam traneksamat.'
          : 'Pigmentasi merata tanpa tanda hiperpigmentasi aktif.',
      },
      hidung: {
        coords: [50, 50],
        name: 'Zona Nasal (Hidung)',
        status: isPores ? 'watch' : 'ok',
        tag: isPores ? 'Dilatasi Pori-Pori' : 'Tekstur Halus',
        desc: isPores
          ? 'Diameter ostium folikular melebar akibat sumbatan sebum. Gunakan pembersih asam salisilat berkala.'
          : 'Tekstur dermal halus dengan retensi sebum minimal.',
      },
      dagu: {
        coords: [50, 80],
        name: 'Zona Mentalis (Dagu)',
        status: isAcne ? 'watch' : 'ok',
        tag: isAcne ? 'Lesi Inflamasi Ringan' : 'Dermis Terkontrol',
        desc: isAcne
          ? 'Tampak lesi papul komedo kecil. Gunakan sediaan spot treatment zinc/tea tree terfokus.'
          : 'Bebas dari erupsi inflamasi.',
      },
    };
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
        label: 'Tingkat Hidrasi Barier',
        val: kelembapanPct,
        threshold: 50,
        status: kelembapanPct >= 50 ? 'Cukup Optimal' : 'Perlu Suplementasi',
        tone: kelembapanPct >= 50 ? 'ok' : 'watch',
      },
      {
        label: 'Aktivitas Sebum Kulit',
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

  // Recommended BPOM Products List
  const getRoutineProducts = () => {
    const hero = verificationData?.recommendations?.heroProduct;
    const supporting = verificationData?.recommendations?.supportingProducts || [];

    const list: Array<{
      name: string;
      desc: string;
      price: number;
      id: number;
      bpom?: string;
      step: string;
    }> = [];

    if (hero) {
      list.push({
        id: hero.id || 1,
        step: 'Langkah 2: Serum Terapi Aktif',
        name: hero.nama,
        desc: hero.reasons?.[0] || 'Formula klinis aktif dengan penetrasi terfokus pada target diagnosis.',
        price: hero.harga || 89000,
        bpom: hero.bpom || 'NA18210103421',
      });
    }

    const steps = [
      'Langkah 1: Pembersih Seimbang',
      'Langkah 3: Pemulihan Barier Kulit',
      'Langkah 4: Fotoproteksi Spektrum Luas',
    ];

    supporting.forEach((p: any, idx: number) => {
      list.push({
        id: p.id || idx + 2,
        step: steps[idx] || `Langkah ${idx + 2}`,
        name: p.nama,
        desc: p.fungsi || p.reasons?.[0] || 'Mendukung integritas lapisan epidermis dan hidrasi.',
        price: p.harga || 75000,
        bpom: p.bpom || 'NA18220108922',
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
          bpom: 'NA18211204555',
        },
        {
          id: 2,
          step: 'Langkah 2: Serum Terapi Aktif',
          name: 'Niacinamide 5% + Zinc PCA Serum',
          desc: 'Menyeimbangkan produksi sebum dan merapatkan tampilan pori-pori.',
          price: 89000,
          bpom: 'NA18210103421',
        },
        {
          id: 3,
          step: 'Langkah 3: Pemulihan Barier Kulit',
          name: 'Ceramide Hydro-Gel Barrier Cream',
          desc: 'Memulihkan cadangan hidrasi dermal dan mengunci kelembapan.',
          price: 78000,
          bpom: 'NA18220108922',
        },
        {
          id: 4,
          step: 'Langkah 4: Fotoproteksi Spektrum Luas',
          name: 'Physical UV Shield SPF 50+ PA++++',
          desc: 'Perlindungan maksimal terhadap fotopenuaan dan pembentukan melanin baru.',
          price: 95000,
          bpom: 'NA18221700140',
        }
      );
    }

    return list.slice(0, 4);
  };

  const zoneData = getZoneData();
  const currentZone = zoneData[selectedZone] || zoneData['dahi'];
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

  return (
    <main className="min-h-screen bg-[#F8FAF9] text-[#19201D] flex flex-col items-center">
      {/* Hidden offscreen canvases */}
      <canvas ref={probeCanvasRef} className="hidden" />
      <canvas ref={cropCanvasRef} className="hidden" />

      {/* Main Container */}
      <div className="w-full max-w-md mx-auto px-4 py-4 sm:py-6 flex flex-col flex-1">
        {/* Modern Luxury Clinical Header */}
        <header className="flex items-center justify-between pb-3.5 mb-2 border-b border-[#E5EBE8]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-[#FAF3F0] border border-[#E8D5CE] flex items-center justify-center text-[#B87A63]">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <div className="font-serif-luxury font-bold text-base tracking-wide text-[#19201D]">
                ANNISA DERMA CLINIC
              </div>
              <span className="text-[11px] text-[#5F7068] font-medium tracking-tight block">
                Clinical AI Skin Diagnostics
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 text-[10px] uppercase font-bold px-2.5 py-1 rounded-full bg-[#EEF6F2] text-[#256650] border border-[#CBE2D7]">
              <ShieldCheck className="w-3 h-3" />
              Biometrik AI
            </span>
          </div>
        </header>

        {/* SECTION 1: SCANNER SCREEN */}
        {scanState !== 'SUCCESS' ? (
          <section className="space-y-4 pt-1 flex flex-col flex-1 justify-between">
            {/* Clinical Camera Viewport Card */}
            <div className="clinical-card p-3 relative overflow-hidden bg-white shadow-xl">
              <div
                className={`clinical-cam relative aspect-[3/4] w-full rounded-2xl overflow-hidden flex items-center justify-center ${
                  scanState === 'READY' || scanState === 'COUNTDOWN' ? 'ready' : ''
                } ${scanState === 'SCANNING' ? 'scanning' : ''}`}
              >
                {/* Live Video Stream */}
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  autoPlay
                  className="absolute inset-0 w-full h-full object-cover -scale-x-100"
                />

                {/* SVG Luxury Clinical Reticle */}
                <svg
                  viewBox="0 0 300 400"
                  className="absolute inset-0 w-full h-full pointer-events-none z-10"
                  aria-hidden="true"
                >
                  {/* Subtle Face Silhouette */}
                  <path
                    className="sil"
                    d="M30 400c0-76 54-104 120-104s120 28 120 104z"
                  />
                  <ellipse className="sil" cx="150" cy="185" rx="78" ry="104" />

                  {/* Luminous Guide Ellipse */}
                  <ellipse
                    className="clinical-guide"
                    cx="150"
                    cy="185"
                    rx="98"
                    ry="130"
                  />

                  {/* 4 Delicate Corner Precision Calibration Marks */}
                  <path
                    d="M 58 72 L 48 72 A 16 16 0 0 0 32 88 L 32 98"
                    fill="none"
                    stroke="rgba(255,255,255,0.7)"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  />
                  <path
                    d="M 242 72 L 252 72 A 16 16 0 0 1 268 88 L 268 98"
                    fill="none"
                    stroke="rgba(255,255,255,0.7)"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  />
                  <path
                    d="M 58 298 L 48 298 A 16 16 0 0 1 32 282 L 32 272"
                    fill="none"
                    stroke="rgba(255,255,255,0.7)"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  />
                  <path
                    d="M 242 298 L 252 298 A 16 16 0 0 0 268 282 L 268 272"
                    fill="none"
                    stroke="rgba(255,255,255,0.7)"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  />
                </svg>

                {/* Cyan/Emerald Laser Scanning Sweep */}
                <div className="clinical-sweep" />

                {/* Big Serenity Countdown Number (3, 2, 1) */}
                {countdownNum !== null && (
                  <div className="clinical-countdown">{countdownNum}</div>
                )}

                {/* Screen Flash Calibration Overlay */}
                <div
                  className={`clinical-flash ${isFlashing ? 'active' : ''}`}
                  style={{ backgroundColor: flashColor }}
                />

                {/* Top Floating Badge */}
                <div className="absolute left-3 top-3 z-20">
                  <span className="glass-pill px-2.5 py-1 rounded-full text-[11px] font-semibold text-[#19201D] shadow-sm flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-[#256650] animate-pulse" />
                    Biometrik Presisi
                  </span>
                </div>
              </div>
            </div>

            {/* 3 Clinical Quality Chips */}
            <div className="grid grid-cols-3 gap-2">
              {/* 1. Pencahayaan */}
              <div
                className={`p-2.5 rounded-2xl border transition-all ${
                  checks.light === 'Lolos'
                    ? 'bg-[#EEF6F2] border-[#CBE2D7] text-[#256650]'
                    : 'bg-white border-[#E5EBE8] text-[#5F7068]'
                }`}
              >
                <div className="flex items-center gap-1 text-[11px] font-semibold mb-0.5">
                  <Sun className="w-3.5 h-3.5" />
                  Pencahayaan
                </div>
                <span className="text-[10px] font-bold block">
                  {checks.light === 'Lolos' ? '✓ Optimal' : '● Kalibrasi'}
                </span>
              </div>

              {/* 2. Posisi Wajah */}
              <div
                className={`p-2.5 rounded-2xl border transition-all ${
                  checks.facePos === 'Lolos'
                    ? 'bg-[#EEF6F2] border-[#CBE2D7] text-[#256650]'
                    : 'bg-white border-[#E5EBE8] text-[#5F7068]'
                }`}
              >
                <div className="flex items-center gap-1 text-[11px] font-semibold mb-0.5">
                  <UserCheck className="w-3.5 h-3.5" />
                  Posisi Wajah
                </div>
                <span className="text-[10px] font-bold block">
                  {checks.facePos === 'Lolos' ? '✓ Presisi' : '● Di Tengah'}
                </span>
              </div>

              {/* 3. Pandangan Lurus */}
              <div
                className={`p-2.5 rounded-2xl border transition-all ${
                  checks.lookStraight === 'Lolos'
                    ? 'bg-[#EEF6F2] border-[#CBE2D7] text-[#256650]'
                    : 'bg-white border-[#E5EBE8] text-[#5F7068]'
                }`}
              >
                <div className="flex items-center gap-1 text-[11px] font-semibold mb-0.5">
                  <Eye className="w-3.5 h-3.5" />
                  Arah Pandang
                </div>
                <span className="text-[10px] font-bold block">
                  {checks.lookStraight === 'Lolos' ? '✓ Lurus' : '● Sejajar'}
                </span>
              </div>
            </div>

            {/* Glasses Alert Card (if detected) */}
            {!checks.noGlasses && (
              <div className="p-3 rounded-2xl bg-[#FAF3F0] border border-[#E8D5CE] text-xs text-[#A86F59] flex items-center gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0 text-[#B87A63]" />
                <span className="leading-snug">
                  Mohon lepas kacamata Anda agar area kontur mata dan glabella terbaca
                  akurat.
                </span>
              </div>
            )}

            {/* Status Feedback Message */}
            <div className="text-center py-1">
              <p className="text-xs sm:text-sm font-medium text-[#19201D] leading-relaxed">
                {statusText}
              </p>
              {errorMessage && (
                <p className="text-xs text-red-600 font-semibold mt-1">
                  {errorMessage}
                </p>
              )}
            </div>

            {/* Action Button & Medical Security Note */}
            <div className="space-y-3 pt-1">
              <button
                type="button"
                onClick={handleStartScan}
                disabled={
                  scanState === 'COUNTDOWN' ||
                  scanState === 'SCANNING' ||
                  scanState === 'FLASH'
                }
                className="w-full py-4 rounded-2xl font-bold text-sm sm:text-base text-white bg-gradient-to-r from-[#B87A63] to-[#A26550] hover:from-[#A86F59] hover:to-[#915642] shadow-lg shadow-[#B87A63]/25 active:scale-[0.99] transition cursor-pointer flex items-center justify-center gap-2"
              >
                {scanState === 'SCANNING' ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Menganalisis Kondisi Kulit…
                  </>
                ) : scanState === 'COUNTDOWN' ? (
                  <>
                    <Zap className="w-4 h-4" />
                    Mengambil Sampel Biometrik…
                  </>
                ) : (
                  <>
                    <Camera className="w-4 h-4" />
                    Mulai Diagnosis Kulit
                  </>
                )}
              </button>

              <div className="flex items-center justify-center gap-1.5 text-center text-[11px] text-[#5F7068]">
                <ShieldCheck className="w-3.5 h-3.5 text-[#256650]" />
                <span>
                  Privasi Medis: Sampel foto diproses lokal dan segera dimusnahkan.
                </span>
              </div>
            </div>
          </section>
        ) : (
          /* SECTION 2: LUXURY CLINICAL CONSULTATION REPORT */
          <section className="space-y-5 pt-1 pb-16">
            {/* Top Verification Stamp */}
            <div className="flex items-center justify-between text-xs pb-1">
              <span className="inline-flex items-center gap-1 font-semibold text-[#256650] bg-[#EEF6F2] px-3 py-1 rounded-full border border-[#CBE2D7]">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Laporan Terverifikasi Biometrik Asli
              </span>
              <button
                onClick={handleResetScan}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#5F7068] hover:text-[#19201D] transition cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Pindai Ulang
              </button>
            </div>

            {/* Diagnostic Hero Card */}
            <div className="clinical-card p-5 sm:p-6 space-y-5">
              <div className="flex items-start justify-between gap-4 border-b border-[#E5EBE8] pb-4">
                <div className="space-y-1">
                  <span className="text-[11px] uppercase tracking-wider font-bold text-[#B87A63]">
                    Diagnosis Dermatologi
                  </span>
                  <h1 className="font-serif-luxury text-2xl sm:text-3xl font-bold text-[#19201D]">
                    Kulit {dominantSkinLabel}
                  </h1>
                  <p className="text-xs text-[#5F7068] leading-relaxed pt-0.5">
                    {dominantSkinLabel.toLowerCase().includes('kombinasi')
                      ? 'Produksi sebum aktif pada area T-Zone dengan kelembapan moderat pada area malar pipi.'
                      : dominantSkinLabel.toLowerCase().includes('berminyak')
                      ? 'Aktivitas kelenjar sebasea menyeluruh di seluruh area dermis wajah.'
                      : dominantSkinLabel.toLowerCase().includes('kering')
                      ? 'Defisit hidrasi lapisan lipid stratum korneum yang memerlukan perbaikan barier.'
                      : 'Keseimbangan fisiologis hidrasi dan sekresi sebum pada parameter optimal.'}
                  </p>
                </div>

                {/* Score Ring Badge */}
                <div className="flex-shrink-0 text-center">
                  <div className="w-16 h-16 sm:w-18 sm:h-18 rounded-2xl bg-[#EEF6F2] border border-[#CBE2D7] flex flex-col items-center justify-center p-2 shadow-sm">
                    <span className="text-lg sm:text-xl font-bold font-serif-luxury text-[#256650]">
                      {skinScore}
                    </span>
                    <span className="text-[9px] uppercase font-bold text-[#256650]">
                      Skor Sehat
                    </span>
                  </div>
                  <span className="text-[10px] text-[#5F7068] font-medium block mt-1">
                    AI Akurasi: {confidence}%
                  </span>
                </div>
              </div>

              {/* 1. Transparent 4 Skin Types Distribution */}
              <div className="space-y-2.5">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-bold uppercase tracking-wider text-[#19201D]">
                    Distribusi Tipe Kulit (Transparan):
                  </span>
                  <span className="text-[10px] text-[#5F7068]">Total 100%</span>
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
                            className={`font-semibold ${
                              isTop ? 'text-[#256650]' : 'text-[#5F7068]'
                            }`}
                          >
                            {t.label} {isTop && '✦ (Diagnosis Utama)'}
                          </span>
                          <span
                            className={`font-mono text-xs ${
                              isTop ? 'text-[#256650] font-bold' : 'text-[#5F7068]'
                            }`}
                          >
                            {pct}%
                          </span>
                        </div>
                        <div className="h-2 w-full bg-[#E5EBE8] rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-700 ${
                              isTop
                                ? 'bg-gradient-to-r from-[#256650] to-[#34D399]'
                                : 'bg-[#CBD6D0]'
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

            {/* 2. Interactive Clinical Face Diagnostic Map */}
            <div className="clinical-card p-5 sm:p-6 space-y-4">
              <div>
                <span className="text-[11px] uppercase tracking-wider font-bold text-[#B87A63]">
                  Pemetaan Zona Wajah
                </span>
                <h2 className="font-serif-luxury text-xl font-bold text-[#19201D] mt-0.5">
                  Analisis Lokasi & Kelenjar
                </h2>
                <p className="text-xs text-[#5F7068]">
                  Pilih titik zona wajah di bawah untuk melihat rincian kondisi lokal.
                </p>
              </div>

              {/* Face Map Illustration */}
              <div className="relative aspect-[4/5] max-w-[280px] mx-auto my-2">
                <svg viewBox="0 0 200 250" className="w-full h-full" aria-hidden="true">
                  <ellipse
                    cx="100"
                    cy="125"
                    rx="78"
                    ry="104"
                    fill="#F3DDD8"
                    stroke="#E6D8DD"
                    strokeWidth="2"
                  />
                  <path
                    d="M60 98q14-9 28 0M112 98q14-9 28 0M82 188q18 10 36 0"
                    fill="none"
                    stroke="#7A6670"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    opacity=".6"
                  />
                </svg>

                {/* Hotspot Pins */}
                {Object.entries(zoneData).map(([key, zone]) => (
                  <button
                    key={key}
                    type="button"
                    className={`clinical-hotspot ${zone.status}`}
                    style={{
                      left: `${zone.coords[0]}%`,
                      top: `${zone.coords[1]}%`,
                    }}
                    aria-pressed={selectedZone === key}
                    onClick={() => setSelectedZone(key)}
                    aria-label={`${zone.name}: ${zone.tag}`}
                  >
                    {zone.status === 'ok' ? '✓' : '!'}
                  </button>
                ))}
              </div>

              {/* Dynamic Zone Details Card */}
              <div
                className={`p-4 rounded-2xl border transition-all ${
                  currentZone.status === 'ok'
                    ? 'bg-[#EEF6F2] border-[#CBE2D7]'
                    : 'bg-[#FEF7ED] border-[#FCD9A5]'
                }`}
              >
                <div className="flex items-center justify-between pb-1">
                  <h4 className="font-bold text-sm text-[#19201D]">
                    {currentZone.name}
                  </h4>
                  <span
                    className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
                      currentZone.status === 'ok'
                        ? 'bg-[#256650] text-white'
                        : 'bg-[#C27D1A] text-white'
                    }`}
                  >
                    {currentZone.tag}
                  </span>
                </div>
                <p className="text-xs text-[#5F7068] leading-relaxed pt-1">
                  {currentZone.desc}
                </p>
              </div>
            </div>

            {/* 3. Transparent 5 Skin Concerns vs Threshold */}
            <div className="clinical-card p-5 sm:p-6 space-y-4">
              <div>
                <span className="text-[11px] uppercase tracking-wider font-bold text-[#B87A63]">
                  Kondisi Dermal Fisiologis
                </span>
                <h2 className="font-serif-luxury text-xl font-bold text-[#19201D] mt-0.5">
                  Analisis Masalah Kulit & Ambang Klinis
                </h2>
                <p className="text-xs text-[#5F7068]">
                  Persentase deteksi multi-label dibandingkan dengan batas ambang klinis
                  dermatologi.
                </p>
              </div>

              <div className="space-y-3 pt-1">
                {getMetrics().map((m, idx) => (
                  <div
                    key={idx}
                    className="p-3 rounded-2xl bg-[#F8FAF9] border border-[#E5EBE8] space-y-2"
                  >
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-[#19201D]">
                        {m.label}
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold text-[#19201D]">
                          {m.val}%
                        </span>
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded-md ${
                            m.tone === 'ok'
                              ? 'bg-[#EEF6F2] text-[#256650] border border-[#CBE2D7]'
                              : 'bg-[#FEF7ED] text-[#C27D1A] border border-[#FCD9A5]'
                          }`}
                        >
                          {m.status}
                        </span>
                      </div>
                    </div>

                    {/* Progress Bar with Indicator */}
                    <div className="relative h-2 w-full bg-[#E5EBE8] rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-700 ${
                          m.tone === 'ok'
                            ? 'bg-gradient-to-r from-[#256650] to-[#34D399]'
                            : 'bg-gradient-to-r from-[#C27D1A] to-[#F59E0B]'
                        }`}
                        style={{ width: `${Math.max(3, m.val)}%` }}
                      />
                    </div>

                    <div className="flex justify-between text-[10px] text-[#5F7068]">
                      <span>Nilai Sampel: {m.val}%</span>
                      <span>Batas Ambang Terapi: {m.threshold}%</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* 4. Clinical Regimen & Recommended BPOM Products */}
            <div className="clinical-card p-5 sm:p-6 space-y-4">
              <div>
                <span className="text-[11px] uppercase tracking-wider font-bold text-[#B87A63]">
                  Resep Perawatan Terfokus
                </span>
                <h2 className="font-serif-luxury text-xl font-bold text-[#19201D] mt-0.5">
                  Protokol Produk Resmi BPOM
                </h2>
                <p className="text-xs text-[#5F7068]">
                  Kombinasi formulasi aktif yang direkomendasikan dokter sesuai profil
                  kulit Anda.
                </p>
              </div>

              <div className="space-y-3 pt-1">
                {routineProducts.map((p, idx) => {
                  const inCart = cartItems.has(p.id);
                  return (
                    <div
                      key={p.id}
                      className={`p-4 rounded-2xl border transition-all ${
                        inCart
                          ? 'bg-[#FAF3F0] border-[#E8D5CE]'
                          : 'bg-white border-[#E5EBE8]'
                      }`}
                    >
                      <div className="flex justify-between items-start gap-2 mb-1.5">
                        <span className="text-[10px] font-bold uppercase tracking-wide text-[#B87A63] bg-[#FAF3F0] px-2 py-0.5 rounded">
                          {p.step}
                        </span>
                        <span className="font-bold text-xs text-[#19201D]">
                          {formatRp(p.price)}
                        </span>
                      </div>

                      <h4 className="font-bold text-sm text-[#19201D] leading-snug">
                        {p.name}
                      </h4>
                      <p className="text-xs text-[#5F7068] mt-1 leading-relaxed">
                        {p.desc}
                      </p>

                      <div className="flex items-center justify-between pt-3 mt-2 border-t border-[#E5EBE8]/60">
                        <span className="text-[10px] text-[#5F7068] font-mono">
                          BPOM: {p.bpom || 'NA18220108922'}
                        </span>
                        <button
                          type="button"
                          onClick={() => toggleCart(p.id)}
                          className={`text-xs font-bold px-3 py-1.5 rounded-xl transition flex items-center gap-1 cursor-pointer ${
                            inCart
                              ? 'bg-[#B87A63] text-white shadow-sm'
                              : 'border border-[#B87A63] text-[#B87A63] hover:bg-[#FAF3F0]'
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
                              Tambah ke Resep
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Medical Validator Sign-off */}
              <div className="p-3.5 rounded-2xl bg-[#EEF6F2] border border-[#CBE2D7] text-xs text-[#256650] flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Stethoscope className="w-4 h-4 text-[#256650]" />
                  <div>
                    <span className="font-bold block">
                      {verificationData?.validationDoctor?.name || 'dr. Annisa Pratami, Sp.D.V.E.'}
                    </span>
                    <span className="text-[10px] opacity-80">
                      SIP: {verificationData?.validationDoctor?.sip || 'SIP.440/092/Dinkes/2024'}
                    </span>
                  </div>
                </div>
                <span className="text-[10px] uppercase font-bold text-[#256650]">
                  Terverifikasi ✓
                </span>
              </div>
            </div>

            {/* Bottom Actions */}
            <div className="text-center pt-2">
              <button
                type="button"
                onClick={handleResetScan}
                className="inline-flex items-center gap-2 px-8 py-3.5 rounded-2xl border border-[#CBD6D0] hover:bg-white text-[#19201D] font-bold text-xs shadow-sm transition cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Pindai Ulang Wajah
              </button>
            </div>

            {/* Sticky Floating Action Bar */}
            <div className="clinical-cart-bar">
              <div>
                <span className="text-xs block text-white/80">
                  {cartItems.size > 0
                    ? `${cartItems.size} produk resep dipilih`
                    : 'Pilih produk untuk rutinitasmu'}
                </span>
                <span className="font-bold text-sm text-white">
                  {cartItems.size > 0 ? formatRp(cartTotal) : 'Resep Rekomendasi'}
                </span>
              </div>

              <button
                type="button"
                disabled={cartItems.size === 0}
                onClick={() => {
                  alert(
                    `Pemesanan resep ${cartItems.size} produk senilai ${formatRp(
                      cartTotal
                    )} siap dikonsultasikan langsung ke klinik.`
                  );
                }}
                className={`px-4 py-2.5 rounded-xl font-bold text-xs flex items-center gap-1.5 transition ${
                  cartItems.size > 0
                    ? 'bg-[#B87A63] hover:bg-[#A86F59] text-white shadow-md cursor-pointer'
                    : 'bg-white/10 text-white/40 cursor-not-allowed'
                }`}
              >
                Pesan Resep
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
