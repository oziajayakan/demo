// app/layout.tsx
import type { Metadata } from 'next';
import Script from 'next/script';
import './globals.css';

export const metadata: Metadata = {
  title: 'Analisis Kulit Wajah · Annisa Beauty Shop',
  description:
    'Sistem pemindai kondisi kulit wajah berbasis deep learning dengan proteksi anti-manipulasi dan rekomendasi produk resmi BPOM.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="id">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400..700;1,9..40,400..700&family=Playfair+Display:ital,wght@0,500..800;1,500..800&display=swap"
          rel="stylesheet"
        />
        <Script
          src="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.js"
          strategy="beforeInteractive"
        />
      </head>
      <body className="min-h-screen flex flex-col bg-slate-50 text-slate-800 antialiased">
        {/* Simple Clean Header */}
        <header className="bg-white border-b border-slate-200 sticky top-0 z-50">
          <div className="max-w-5xl mx-auto px-4 py-3.5 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-brand-700 flex items-center justify-center font-serif font-bold text-white text-base">
                A
              </div>
              <div>
                <span className="font-serif font-bold text-lg text-slate-900 tracking-tight">
                  ANNISA BEAUTY SHOP
                </span>
                <span className="block text-[11px] text-slate-500 font-medium">
                  Skin Analysis
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                Anti-Spoofing
              </span>
            </div>
          </div>
        </header>

        {/* Main Body */}
        <main className="flex-1">{children}</main>

        {/* Clean Standard Footer */}
        <footer className="bg-white border-t border-slate-200 py-6 text-center text-xs text-slate-500">
          <div className="max-w-5xl mx-auto px-4 space-y-1">
            <p className="font-medium text-slate-700">
              Beauty in your Home, A Better You · © 2026 Annisa Beauty Shop
            </p>
            <p className="text-[11px] text-slate-400">
              Foto wajah diproses langsung di peramban dan tidak disimpan di server. Hasil pemindaian bertujuan sebagai panduan perawatan kosmetik dan bukan merupakan diagnosis medis.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
