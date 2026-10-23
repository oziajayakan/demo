// app/layout.tsx
import type { Metadata } from 'next';
import Script from 'next/script';
import './globals.css';

export const metadata: Metadata = {
  title: 'Skin Analysis Anti-Manipulasi · Annisa Beauty Shop',
  description:
    'Sistem pemindai kondisi kulit wajah cerdas berbasis Deep Learning ONNX dengan proteksi anti-spoofing Dynamic Screen Flash dan validasi dermatolog.',
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
      <body className="min-h-screen flex flex-col bg-[#0B0314] text-[#F8EDF9] antialiased selection:bg-[#FF2A85] selection:text-white">
        {/* Navigation Bar */}
        <header className="border-b border-plum-700/40 bg-[#160523]/80 backdrop-blur-md sticky top-0 z-50">
          <div className="max-w-6xl mx-auto px-4 py-3.5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-[#8E1366] to-[#FF2A85] flex items-center justify-center font-serif font-bold text-lg text-white shadow-lg shadow-[#8E1366]/40">
                A
              </div>
              <div>
                <span className="font-serif font-bold text-xl tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-white via-[#FCEBFA] to-[#FF80BF]">
                  ANNISA BEAUTY SHOP
                </span>
                <span className="block text-[10px] tracking-widest text-plum-400 uppercase font-semibold">
                  Skin Biometric & Clinical AI
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="hidden sm:inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1 rounded-full bg-[#00F0FF]/10 text-[#00F0FF] border border-[#00F0FF]/30">
                <span className="w-2 h-2 rounded-full bg-[#00F0FF] animate-ping" />
                Anti-Spoofing Active
              </span>
              <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-plum-800 text-plum-300 border border-plum-700">
                v2.0 Vercel Edition
              </span>
            </div>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1">{children}</main>

        {/* Footer */}
        <footer className="border-t border-plum-800/60 bg-[#090210] py-6 text-center text-xs text-plum-400/80">
          <p className="font-serif text-sm text-plum-300 mb-1">
            Beauty in your Home, A Better You
          </p>
          <p>© 2026 Annisa Beauty Shop · Tervalidasi Klinis Dokter Spesialis Kulit (Sp.D.V.E)</p>
          <p className="text-[11px] text-plum-500 mt-1 max-w-xl mx-auto px-4">
            Foto wajah diproses lokal secara aman di memori perangkat dan tidak diunggah ke server cloud. Hasil pemindaian bertujuan untuk rekomendasi perawatan kosmetik dan bukan merupakan diagnosis medis pengganti dokter.
          </p>
        </footer>
      </body>
    </html>
  );
}
