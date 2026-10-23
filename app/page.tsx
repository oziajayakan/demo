// app/page.tsx
'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  ShieldCheck,
  Zap,
  Lock,
  Camera,
  CheckCircle2,
  Sparkles,
  Award,
  AlertTriangle,
} from 'lucide-react';

export default function HomePage() {
  const [agreed, setAgreed] = useState(false);

  return (
    <div className="min-h-[90vh] py-10 px-4 sm:px-6 relative overflow-hidden">
      {/* Background Ambient Glows */}
      <div className="absolute top-10 left-1/2 -translate-x-1/2 w-[600px] h-[350px] bg-gradient-to-b from-[#8E1366]/25 via-[#FF2A85]/10 to-transparent blur-3xl pointer-events-none -z-10" />

      <div className="max-w-4xl mx-auto space-y-12">
        {/* Hero Section */}
        <div className="text-center space-y-5">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-[#FF2A85]/10 border border-[#FF2A85]/30 text-[#FF80BF] text-xs font-semibold tracking-wide">
            <Sparkles className="w-3.5 h-3.5 text-[#FF2A85]" />
            Deep Learning AI · MobileNetV3 Multitask Engine
          </div>

          <h1 className="font-serif text-4xl sm:text-6xl font-bold tracking-tight text-white leading-tight">
            Analisis Kulit Wajah Nyata,<br />
            <span className="italic font-normal text-transparent bg-clip-text bg-gradient-to-r from-[#FF80BF] via-[#FCEBFA] to-[#00F0FF]">
              Bebas Manipulasi & Filter.
            </span>
          </h1>

          <p className="max-w-2xl mx-auto text-sm sm:text-base text-plum-300/90 leading-relaxed">
            Teknologi pemindai dermatologis mutakhir dengan sistem verifikasi{' '}
            <strong className="text-white font-semibold">Dynamic Screen Flash Challenge</strong>. Memastikan pemindaian berasal dari kulit manusia asli secara langsung, menolak foto cetak kertas dan replay layar gadget.
          </p>
        </div>

        {/* 3 Keunggulan Proteksi Anti-Manipulasi */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="glass-card rounded-2xl p-5 space-y-3 border-plum-700/50 hover:border-[#00F0FF]/40 transition duration-300">
            <div className="w-10 h-10 rounded-xl bg-[#00F0FF]/10 border border-[#00F0FF]/30 flex items-center justify-center text-[#00F0FF]">
              <Zap className="w-5 h-5" />
            </div>
            <h3 className="font-semibold text-base text-white">
              Dynamic Flash Challenge
            </h3>
            <p className="text-xs text-plum-300 leading-relaxed">
              Layar memancarkan kilatan spektrum warna acak dalam 160 ms untuk mengukur penyerapan cahaya difus pada pori-pori kulit asli vs layar digital/kertas foto.
            </p>
          </div>

          <div className="glass-card rounded-2xl p-5 space-y-3 border-plum-700/50 hover:border-[#FF2A85]/40 transition duration-300">
            <div className="w-10 h-10 rounded-xl bg-[#FF2A85]/10 border border-[#FF2A85]/30 flex items-center justify-center text-[#FF2A85]">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <h3 className="font-semibold text-base text-white">
              Hardware Camera Lock
            </h3>
            <p className="text-xs text-plum-300 leading-relaxed">
              Kebijakan <span className="text-[#FF80BF] font-medium">Zero-Upload</span>. Mencegah manipulasi gambar editan, foto lawas galeri, atau video rekaman virtual camera (OBS).
            </p>
          </div>

          <div className="glass-card rounded-2xl p-5 space-y-3 border-plum-700/50 hover:border-emerald-400/40 transition duration-300">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-400/30 flex items-center justify-center text-emerald-400">
              <Lock className="w-5 h-5" />
            </div>
            <h3 className="font-semibold text-base text-white">
              100% Client-Side Privacy
            </h3>
            <p className="text-xs text-plum-300 leading-relaxed">
              Seluruh inferensi komputasi ONNX WebAssembly berjalan di peramban Anda. Foto wajah tidak pernah dikirim atau disimpan di server cloud.
            </p>
          </div>
        </div>

        {/* Validasi Dokter & Pedoman Pengambilan */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
          {/* Card Dokter Sp.D.V.E */}
          <div className="glass-card rounded-2xl p-6 border-l-4 border-l-[#FF2A85] flex flex-col justify-between space-y-4">
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-[#FF80BF]">
                <Award className="w-4 h-4 text-[#FF2A85]" />
                Validasi Klinis Dermatologi
              </div>
              <h4 className="font-serif font-bold text-lg text-white">
                Protokol Evaluasi Ilmiah & Rekomendasi BPOM
              </h4>
              <p className="text-xs text-plum-300 leading-relaxed">
                Basis data klasifikasi tipe dan masalah kulit diselaraskan dengan standar klinis dermatolog:
              </p>
              <ul className="text-xs text-plum-200/90 space-y-1.5 list-none">
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                  <span><strong>dr. Amanda Lestari, Sp.D.V.E</strong> (SIP: 503/442-DINKES/2023)</span>
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                  <span>Tingkat Kesepakatan Inter-Rater: Cohen's Kappa κ = 0.78</span>
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                  <span>32 Rekomendasi Produk Resmi Terdaftar BPOM RI</span>
                </li>
              </ul>
            </div>

            <div className="pt-2 text-[11px] text-plum-400/80 italic border-t border-plum-800/50">
              * Hasil analisis ditujukan sebagai pendukung keputusan pemilihan perawatan kosmetik harian, bukan diagnosis penyakit medis.
            </div>
          </div>

          {/* Tips Pemindaian Ideal */}
          <div className="glass-card rounded-2xl p-6 space-y-4">
            <h4 className="font-semibold text-sm uppercase tracking-wider text-plum-300">
              Panduan Pemindaian Akurat:
            </h4>
            <div className="space-y-3 text-xs text-plum-200">
              <div className="flex items-start gap-3 p-2.5 rounded-xl bg-plum-900/60 border border-plum-700/40">
                <span className="w-5 h-5 rounded-full bg-plum-700 text-white font-bold flex items-center justify-center flex-shrink-0 text-[10px]">
                  1
                </span>
                <div>
                  <strong className="text-white block">Pencahayaan Alami & Merata</strong>
                  Hadap ke arah jendela atau lampu ruangan tanpa bayangan tajam di salah satu sisi wajah.
                </div>
              </div>

              <div className="flex items-start gap-3 p-2.5 rounded-xl bg-plum-900/60 border border-plum-700/40">
                <span className="w-5 h-5 rounded-full bg-plum-700 text-white font-bold flex items-center justify-center flex-shrink-0 text-[10px]">
                  2
                </span>
                <div>
                  <strong className="text-white block">Wajah Bersih Tanpa Makeup / Filter</strong>
                  Hindari bedak tebal atau filter kecantikan peramban agar tekstur pori asli terdeteksi.
                </div>
              </div>

              <div className="flex items-start gap-3 p-2.5 rounded-xl bg-plum-900/60 border border-plum-700/40">
                <span className="w-5 h-5 rounded-full bg-plum-700 text-white font-bold flex items-center justify-center flex-shrink-0 text-[10px]">
                  3
                </span>
                <div>
                  <strong className="text-white block">Bebas Oklusi (Lepas Kacamata & Masker)</strong>
                  Singkirkan poni rambut yang menutupi dahi dan pastikan wajah tegak lurus menghadap kamera.
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Action & Informed Consent Box */}
        <div className="glass-card-glow rounded-3xl p-6 sm:p-8 text-center space-y-6 max-w-2xl mx-auto">
          <div className="space-y-2">
            <h3 className="font-serif text-2xl font-bold text-white">
              Siap Memulai Pemindaian Kulit?
            </h3>
            <p className="text-xs sm:text-sm text-plum-300">
              Posisikan wajah Anda pada bingkai oval yang akan muncul di layar.
            </p>
          </div>

          <label className="flex items-center justify-center gap-3 cursor-pointer select-none text-left max-w-lg mx-auto">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className="w-5 h-5 rounded bg-plum-900 border-plum-600 text-[#FF2A85] focus:ring-[#FF2A85] focus:ring-offset-0 transition cursor-pointer"
            />
            <span className="text-xs text-plum-200 leading-snug">
              Saya menyetujui lembar persetujuan (*Informed Consent*), memahami bahwa foto diproses secara lokal dan tidak diunggah ke cloud.
            </span>
          </label>

          <div>
            <Link
              href={agreed ? '/scan' : '#'}
              className={`inline-flex items-center justify-center gap-2.5 px-8 py-4 rounded-full font-bold text-sm tracking-wide transition-all duration-300 shadow-xl ${
                agreed
                  ? 'bg-gradient-to-r from-[#8E1366] via-[#A01F77] to-[#FF2A85] text-white hover:scale-105 shadow-[#FF2A85]/30 cursor-pointer'
                  : 'bg-plum-900 text-plum-500 border border-plum-800 cursor-not-allowed opacity-60'
              }`}
            >
              <Camera className="w-4 h-4" />
              Mulai Pemindaian Anti-Manipulasi
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
