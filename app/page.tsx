// app/page.tsx
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Camera, Check, ShieldCheck, Sun, Sparkles, UserCheck } from 'lucide-react';

export default function HomePage() {
  const [agreed, setAgreed] = useState(false);

  return (
    <div className="py-10 px-4 sm:px-6">
      <div className="max-w-3xl mx-auto space-y-8">
        {/* Hero Section */}
        <div className="text-center space-y-4">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-brand-50 text-brand-700 text-xs font-semibold border border-brand-200">
            <Sparkles className="w-3.5 h-3.5" />
            Pemindai Cerdas Berbasis AI
          </span>

          <h1 className="font-serif text-3xl sm:text-5xl font-bold text-slate-900 leading-tight">
            Kenali Kondisi Kulit Wajah<br />
            <span className="text-brand-700 font-normal italic">
              dalam hitungan detik.
            </span>
          </h1>

          <p className="max-w-xl mx-auto text-sm sm:text-base text-slate-600 leading-relaxed">
            Sistem analisis tipe dan masalah kulit wajah dengan perlindungan anti-manipulasi (Dynamic Screen Flash). Dapatkan rekomendasi produk perawatan resmi BPOM yang sesuai dengan kebutuhan kulit Anda.
          </p>
        </div>

        {/* 3 Panduan Sederhana */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm space-y-2">
            <div className="w-8 h-8 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center">
              <Sun className="w-4 h-4" />
            </div>
            <h3 className="font-semibold text-sm text-slate-800">Cahaya Cukup</h3>
            <p className="text-xs text-slate-500 leading-relaxed">
              Hadapkan wajah ke sumber cahaya yang merata (misalnya dekat jendela atau lampu).
            </p>
          </div>

          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm space-y-2">
            <div className="w-8 h-8 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center">
              <UserCheck className="w-4 h-4" />
            </div>
            <h3 className="font-semibold text-sm text-slate-800">Wajah Bersih</h3>
            <p className="text-xs text-slate-500 leading-relaxed">
              Hindari bedak tebal atau filter kamera agar kondisi pori dan kulit asli terbaca jelas.
            </p>
          </div>

          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm space-y-2">
            <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center">
              <ShieldCheck className="w-4 h-4" />
            </div>
            <h3 className="font-semibold text-sm text-slate-800">Lepas Kacamata</h3>
            <p className="text-xs text-slate-500 leading-relaxed">
              Lepas kacamata dan rapikan rambut dari dahi agar area mata dan kulit terlihat utuh.
            </p>
          </div>
        </div>

        {/* Start Card */}
        <div className="bg-white p-6 sm:p-8 rounded-2xl border border-slate-200 shadow-sm text-center space-y-6">
          <div className="space-y-1">
            <h2 className="font-semibold text-lg text-slate-900">
              Mulai Pemindaian Wajah
            </h2>
            <p className="text-xs sm:text-sm text-slate-500">
              Kamera akan aktif untuk memindai wajah langsung di peramban Anda.
            </p>
          </div>

          {/* Consent Checkbox */}
          <label className="flex items-start sm:items-center justify-center gap-3 cursor-pointer text-left max-w-lg mx-auto">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className="mt-0.5 sm:mt-0 w-4 h-4 rounded border-slate-300 text-brand-700 focus:ring-brand-500 cursor-pointer"
            />
            <span className="text-xs text-slate-600 leading-snug">
              Saya memahami bahwa foto diproses secara lokal di perangkat ini dan tidak disimpan di server.
            </span>
          </label>

          {/* Action Button */}
          <div>
            <Link
              href={agreed ? '/scan' : '#'}
              className={`inline-flex items-center justify-center gap-2 px-8 py-3.5 rounded-xl font-semibold text-sm transition-all ${
                agreed
                  ? 'bg-brand-700 text-white hover:bg-brand-800 shadow-sm cursor-pointer'
                  : 'bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200'
              }`}
            >
              <Camera className="w-4 h-4" />
              Mulai Pindai Kulit
            </Link>
          </div>

          <div className="pt-2 text-[11px] text-slate-400 border-t border-slate-100">
            Tervalidasi klinis bersama dr. Amanda Lestari, Sp.D.V.E · 32 Produk Rekomendasi Resmi BPOM
          </div>
        </div>
      </div>
    </div>
  );
}
