// app/page.tsx
'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
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

export default function HomeScanPage() {
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
  const [statusText, setStatusText] = useState('Posisikan wajah di dalam bingkai');
  const [countdownNum, setCountdownNum] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  // 3 Checks
  const [checks, setChecks] = useState({
    light: 'Menunggu' as 'Menunggu' | 'Memeriksa' | 'Lolos',
    facePos: 'Menunggu' as 'Menunggu' | 'Memeriksa' | 'Lolos',
    lookStraight: 'Menunggu' as 'Menunggu' | 'Memeriksa' | 'Lolos',
    noGlasses: true,
  });

  // Results
  const [verificationData, setVerificationData] = useState<any>(null);
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
              cx >= 0.32 && cx <= 0.68 && cy >= 0.25 && cy <= 0.70 && faceH >= 0.32;

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
        setStatusText('Mohon lepas kacamata Anda');
      } else if (!isLightOk) {
        setStatusText(
          avgLuma < 65
            ? 'Pencahayaan kurang, hadap ke sumber cahaya'
            : 'Pencahayaan terlalu silau'
        );
      } else if (!isPosOk) {
        setStatusText('Posisikan wajah tepat di dalam bingkai oval');
      } else if (!isStraightOk) {
        setStatusText('Arahkan pandangan lurus ke arah kamera');
      } else {
        setStatusText('Tahan posisi. Foto diambil sebentar lagi.');
      }

      if (allReady && scanState !== 'READY') {
        setScanState('READY');
      } else if (!allReady && scanState === 'READY') {
        setScanState('CHECKING');
      }
    };

    timerRef.current = setInterval(checkFrame, 100);
    return () => clearInterval(timerRef.current);
  }, [scanState]);

  // 4. Countdown & Flash Liveness Flow
  const handleStartScan = async () => {
    if (scanState === 'COUNTDOWN' || scanState === 'SCANNING') return;
    setScanState('COUNTDOWN');
    setStatusText('Tahan posisi. Foto diambil sebentar lagi.');

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
      setStatusText('Verifikasi gagal: gunakan wajah asli');
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
    setStatusText('Menganalisis kulitmu…');

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
    setErrorMessage('');
    setCartItems(new Set());
    setStatusText('Posisikan wajah di dalam bingkai');
    setChecks({
      light: 'Menunggu',
      facePos: 'Menunggu',
      lookStraight: 'Menunggu',
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
        name: 'Dahi',
        status: isOilyT ? 'watch' : 'ok',
        tag: isOilyT ? 'Berminyak' : 'Seimbang',
        desc: isOilyT
          ? 'Minyak berlebih di area T. Pakai pembersih lembut dan serum pengontrol minyak.'
          : 'Kondisi dahi seimbang dan terlindungi dengan baik.',
      },
      pipiK: {
        coords: [27, 52],
        name: 'Pipi kiri',
        status: dominantType === 'kering' || isRedness ? 'watch' : 'ok',
        tag:
          dominantType === 'kering'
            ? 'Agak kering'
            : isRedness
            ? 'Kemerahan'
            : 'Seimbang',
        desc:
          dominantType === 'kering'
            ? 'Kelembapan rendah. Tambahkan pelembap gel ringan pagi dan malam.'
            : isRedness
            ? 'Tampak sensitivitas ringan. Gunakan pelembap ber-ceramide/panthenol.'
            : 'Kondisi kelembapan pipi cukup baik.',
      },
      pipiR: {
        coords: [73, 52],
        name: 'Pipi kanan',
        status: isDarkSpots ? 'watch' : 'ok',
        tag: isDarkSpots ? 'Noda ringan' : 'Seimbang',
        desc: isDarkSpots
          ? 'Terdapat noda bekas jerawat/flek halus. Lindungi dengan tabir surya SPF 50.'
          : 'Kondisi baik. Pertahankan rutinitas pelembapmu.',
      },
      hidung: {
        coords: [50, 50],
        name: 'Hidung',
        status: isPores ? 'watch' : 'ok',
        tag: isPores ? 'Pori terlihat' : 'Halus',
        desc: isPores
          ? 'Pori terlihat melebar karena produksi sebum. Bersihkan lembut setiap malam.'
          : 'Tekstur kulit hidung halus dan bersih.',
      },
      dagu: {
        coords: [50, 80],
        name: 'Dagu',
        status: isAcne ? 'watch' : 'ok',
        tag: isAcne ? 'Jerawat ringan' : 'Terkontrol',
        desc: isAcne
          ? 'Ada komedo dan bintik merah kecil. Hindari memencet dan oleskan gel spot.'
          : 'Area dagu bersih dan terawat dengan baik.',
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
        label: 'Kelembapan',
        val: kelembapanPct,
        status: kelembapanPct >= 50 ? 'Cukup' : 'Kurang',
        tone: kelembapanPct >= 50 ? 'ok' : 'watch',
      },
      {
        label: 'Minyak',
        val: minyakPct,
        status: minyakPct > 60 ? 'Agak tinggi' : 'Seimbang',
        tone: minyakPct > 60 ? 'watch' : 'ok',
      },
      {
        label: 'Pori-pori',
        val: poriPct,
        status: poriPct > 45 ? 'Sedang' : 'Halus',
        tone: poriPct > 45 ? 'watch' : 'ok',
      },
      {
        label: 'Noda gelap',
        val: nodaPct,
        status: nodaPct > 45 ? 'Terlihat' : 'Ringan',
        tone: nodaPct > 45 ? 'watch' : 'ok',
      },
      {
        label: 'Kemerahan',
        val: kemerahanPct,
        status: kemerahanPct > 40 ? 'Sensitif' : 'Rendah',
        tone: kemerahanPct > 40 ? 'watch' : 'ok',
      },
      {
        label: 'Garis halus',
        val: garisPct,
        status: garisPct > 45 ? 'Terlihat' : 'Rendah',
        tone: garisPct > 45 ? 'watch' : 'ok',
      },
    ];
  };

  // Recommended Products List
  const getRoutineProducts = () => {
    const hero = verificationData?.recommendations?.heroProduct;
    const supporting = verificationData?.recommendations?.supportingProducts || [];

    const list: Array<{ name: string; desc: string; price: number; id: number }> =
      [];

    if (hero) {
      list.push({
        id: hero.id || 1,
        name: hero.nama,
        desc: hero.reasons?.[0] || 'Produk utama yang paling sesuai dengan profil kulitmu.',
        price: hero.harga || 89000,
      });
    }

    supporting.forEach((p: any, idx: number) => {
      list.push({
        id: p.id || idx + 2,
        name: p.nama,
        desc: p.fungsi || p.reasons?.[0] || 'Mendukung pemulihan barier pelindung kulit.',
        price: p.harga || 75000,
      });
    });

    if (list.length === 0) {
      list.push(
        {
          id: 1,
          name: 'Gel pembersih lembut',
          desc: 'Mengangkat minyak tanpa membuat pipi terasa tarik.',
          price: 65000,
        },
        {
          id: 2,
          name: 'Serum niacinamide 5%',
          desc: 'Menenangkan pori dan mengontrol minyak di area T.',
          price: 89000,
        },
        {
          id: 3,
          name: 'Pelembap gel ringan',
          desc: 'Menambah kelembapan pipi tanpa rasa lengket.',
          price: 78000,
        },
        {
          id: 4,
          name: 'Tabir surya SPF 50',
          desc: 'Menjaga noda gelap agar tidak bertambah.',
          price: 95000,
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

  return (
    <main className="app">
      {/* Hidden offscreen canvases */}
      <canvas ref={probeCanvasRef} className="hidden" />
      <canvas ref={cropCanvasRef} className="hidden" />

      {/* Header */}
      <header className="top">
        <div className="brand">Annisa Beauty Shop</div>
        <span className="sub">Analisis kulit wajah</span>
      </header>

      {/* SECTION 1: SCANNER */}
      {scanState !== 'SUCCESS' ? (
        <section id="scan">
          {/* Camera Viewport */}
          <div
            className={`cam ${
              scanState === 'READY' || scanState === 'COUNTDOWN' ? 'ready' : ''
            } ${scanState === 'SCANNING' ? 'scanning' : ''}`}
            id="cam"
          >
            {/* Live Video */}
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              className="absolute inset-0 w-full h-full object-cover -scale-x-100"
            />

            {/* SVG Guide & Silhouette */}
            <svg viewBox="0 0 300 400" aria-hidden="true">
              <path
                className="sil"
                d="M30 400c0-76 54-104 120-104s120 28 120 104z"
              />
              <ellipse className="sil" cx="150" cy="185" rx="78" ry="104" />
              <ellipse className="guide" cx="150" cy="185" rx="98" ry="130" />
            </svg>

            {/* Pink Sweep Scanline during analysis */}
            <div className="scanline" />

            {/* Large Young Serif Countdown Overlay */}
            {countdownNum !== null && (
              <div className="count" id="count">
                {countdownNum}
              </div>
            )}

            {/* Screen Flash Overlay with Challenge Color */}
            <div
              className={`flash ${isFlashing ? 'on' : ''}`}
              style={{ backgroundColor: flashColor }}
            />

            <div className="tag">Live Biometrik · Anti-Spoof</div>
          </div>

          {/* 3 Real-time Check Chips */}
          <ul className="checks" id="checks">
            <li
              className={
                checks.light === 'Lolos'
                  ? 'ok'
                  : checks.light === 'Memeriksa'
                  ? 'run'
                  : ''
              }
            >
              Pencahayaan
              <small>{checks.light}</small>
            </li>
            <li
              className={
                checks.facePos === 'Lolos'
                  ? 'ok'
                  : checks.facePos === 'Memeriksa'
                  ? 'run'
                  : ''
              }
            >
              Posisi wajah
              <small>{checks.facePos}</small>
            </li>
            <li
              className={
                checks.lookStraight === 'Lolos'
                  ? 'ok'
                  : checks.lookStraight === 'Memeriksa'
                  ? 'run'
                  : ''
              }
            >
              Pandangan lurus
              <small>{checks.lookStraight}</small>
            </li>
          </ul>

          {/* Real-time Status Message */}
          <p className="status" id="status" role="status">
            {statusText}
          </p>

          {/* Error alert if any */}
          {errorMessage && (
            <p className="text-xs text-red-600 text-center pb-2 font-medium">
              {errorMessage}
            </p>
          )}

          {/* Action Button */}
          <button
            className="btn"
            id="start"
            onClick={handleStartScan}
            disabled={
              scanState === 'COUNTDOWN' ||
              scanState === 'SCANNING' ||
              scanState === 'FLASH'
            }
          >
            {scanState === 'SCANNING'
              ? 'Memindai…'
              : scanState === 'COUNTDOWN'
              ? 'Mengambil foto…'
              : 'Mulai pindai'}
          </button>

          {/* Privacy Note */}
          <p className="note">
            Kami tidak menyimpan fotomu. Foto dihapus segera setelah analisis
            selesai. Layanan untuk usia 16 tahun ke atas.
          </p>
        </section>
      ) : (
        /* SECTION 2: RESULT VIEW */
        <section id="result">
          <p className="okline">✓ Wajah asli terverifikasi. Fotomu sudah dihapus.</p>
          <h1>Kulit {dominantSkinLabel}</h1>
          <p className="lead">
            {dominantSkinLabel.toLowerCase().includes('kombinasi')
              ? 'Area T berminyak, pipi sedikit kering. Fokus ke kelembapan dan kontrol minyak yang seimbang.'
              : dominantSkinLabel.toLowerCase().includes('berminyak')
              ? 'Produksi sebum aktif di seluruh area wajah. Fokus ke pembersihan pori dan kontrol sebum ringan.'
              : dominantSkinLabel.toLowerCase().includes('kering')
              ? 'Kadar air dan kelembapan rendah. Prioritaskan hidrasi mendalam dengan ceramide dan pelembap gel.'
              : 'Keseimbangan kadar air dan minyak sangat baik. Pertahankan hidrasi dan tabir surya harian.'}
          </p>

          {/* Interactive Face Map */}
          <div className="map">
            <svg viewBox="0 0 200 250" aria-hidden="true">
              <ellipse
                cx="100"
                cy="125"
                rx="78"
                ry="104"
                fill="var(--face)"
                stroke="var(--line)"
                strokeWidth="2"
              />
              <path
                d="M60 98q14-9 28 0M112 98q14-9 28 0M82 188q18 10 36 0"
                fill="none"
                stroke="var(--muted)"
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
                className={`hs ${zone.status}`}
                style={{ left: `${zone.coords[0]}%`, top: `${zone.coords[1]}%` }}
                aria-pressed={selectedZone === key}
                onClick={() => setSelectedZone(key)}
                aria-label={`${zone.name}: ${zone.tag}`}
              >
                {zone.status === 'ok' ? '✓' : '!'}
              </button>
            ))}
          </div>

          {/* Zone Details Callout */}
          <div className={`zone ${currentZone.status}`} id="zone" aria-live="polite">
            <b>{currentZone.name}</b>
            <span>{currentZone.tag}</span>
            <p>{currentZone.desc}</p>
          </div>

          {/* Transparent Skin Conditions Breakdown */}
          <h2>Kondisi kulitmu</h2>
          <ul className="met">
            {getMetrics().map((m, idx) => (
              <li key={idx}>
                <div className="row">
                  {m.label}
                  <span>
                    <b>{m.val}%</b> {m.status}
                  </span>
                </div>
                <div className="bar">
                  <i className={m.tone} style={{ width: `${m.val}%` }} />
                </div>
              </li>
            ))}
          </ul>

          {/* Product Recommendations Routine */}
          <h2>Rutinitas untukmu</h2>
          <ol className="rt">
            {routineProducts.map((p, i) => {
              const inCart = cartItems.has(p.id);
              return (
                <li key={p.id}>
                  <span className="n">{i + 1}</span>
                  <div>
                    <b>{p.name}</b>
                    <p>{p.desc}</p>
                    <span className="price">{formatRp(p.price)}</span>
                  </div>
                  <button
                    type="button"
                    className="add"
                    aria-pressed={inCart}
                    onClick={() => toggleCart(p.id)}
                  >
                    {inCart ? 'Ditambahkan' : 'Tambah'}
                  </button>
                </li>
              );
            })}
          </ol>

          <p className="fine">
            Rekomendasi bersifat umum dan tidak menggantikan nasihat dokter kulit.
            Nomor notifikasi BPOM tampil di halaman tiap produk.
          </p>

          <button className="btn ghost" id="again" onClick={handleResetScan}>
            Pindai ulang
          </button>

          {/* Sticky Bottom Cart Bar */}
          <div className="cart">
            <span id="ct">
              {cartItems.size > 0
                ? `${cartItems.size} produk · ${formatRp(cartTotal)}`
                : 'Pilih produk untuk rutinitasmu'}
            </span>
            <button
              type="button"
              className="btn"
              id="buy"
              disabled={cartItems.size === 0}
              onClick={() => {
                alert(
                  `Terima kasih! Anda memilih ${cartItems.size} produk senilai ${formatRp(
                    cartTotal
                  )}. Lanjutkan konsultasi ke toko.`
                );
              }}
            >
              Beli di toko
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
