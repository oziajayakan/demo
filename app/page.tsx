// app/page.tsx
'use client';

import { useEffect } from 'react';

export default function SmartSkinScannerApp() {
  useEffect(() => {
    // Arahkan ke auto-scan interface anti-manipulasi 3D liveness
    window.location.replace('/index.html');
  }, []);

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: '#0b0f19',
        color: '#f9fafb',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: "'Plus Jakarta Sans', system-ui, -apple-system, sans-serif",
      }}
    >
      <div
        style={{
          width: '42px',
          height: '42px',
          border: '3px solid rgba(99, 102, 241, 0.2)',
          borderTopColor: '#6366f1',
          borderRadius: '50%',
          animation: 'spin 0.9s linear infinite',
        }}
      />
      <p style={{ marginTop: '16px', fontSize: '14px', color: '#9ca3af' }}>
        Memuat Smart Skin Scanner · Toko Annisa Beauty Shop...
      </p>
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
