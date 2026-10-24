// app/layout.tsx
import type { Metadata } from 'next';
import Script from 'next/script';
import './globals.css';

export const metadata: Metadata = {
  title: 'Smart Skin Scanner · Toko Annisa Beauty Shop',
  description:
    'Sistem pemindai kondisi kulit wajah real-time berbasis deep learning (MobileNetV3 ONNX) dan rekomendasi produk skincare berbasis aturan katalog Toko Annisa Beauty Shop.',
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
          href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,600;0,700;1,500&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Young+Serif&display=swap"
          rel="stylesheet"
        />
        <Script
          src="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.js"
          strategy="beforeInteractive"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
