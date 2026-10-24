// app/api/scan/verify/route.ts
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import productsData from '@/public/products.json';
import { matchProducts } from '@/lib/recommendations';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      sessionId,
      nonce,
      issuedAt,
      flashColor,
      signature,
      livenessResult,
      prediction,
    } = body;

    if (!sessionId || !nonce || !issuedAt || !signature || !prediction) {
      return NextResponse.json(
        { status: 'error', message: 'Payload data tidak lengkap' },
        { status: 400 }
      );
    }

    // 1. Verify Session Nonce Signature (Anti-DevTools Manipulation)
    const secret = process.env.SESSION_SECRET || 'annisa_anti_manipulation_secret_2026';
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(`${sessionId}:${nonce}:${issuedAt}:${flashColor}`);
    const expectedSig = hmac.digest('hex');

    if (expectedSig !== signature) {
      return NextResponse.json(
        {
          status: 'error',
          code: 'TAMPER_DETECTED',
          message: 'Tanda tangan sesi tidak valid. Manipulasi klien terdeteksi.',
        },
        { status: 403 }
      );
    }

    // 2. Anti-Replay Timestamp Audit (TTL 15 Menit agar user tidak terburu-buru)
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec - issuedAt > 900 || issuedAt > nowSec + 30) {
      return NextResponse.json(
        {
          status: 'error',
          code: 'SESSION_EXPIRED',
          message: 'Sesi scan telah kedaluwarsa. Harap lakukan pemindaian ulang.',
        },
        { status: 400 }
      );
    }

    // 3. Verify Liveness Score (Strict Anti-Spoof: Reject other screens & photos)
    if (
      !livenessResult ||
      !livenessResult.passed ||
      (typeof livenessResult.metrics?.chromaticShift === 'number' &&
        livenessResult.metrics.chromaticShift < 70) ||
      livenessResult.metrics?.blinkVerified === false ||
      livenessResult.metrics?.bezelDetected === true
    ) {
      return NextResponse.json(
        {
          status: 'error',
          code: 'SPOOF_REJECTED',
          message:
            livenessResult?.reason ||
            'Verifikasi gagal: terdeteksi layar perangkat lain atau foto fisik.',
        },
        { status: 422 }
      );
    }

    // 4. Recommendation Engine
    const skinType = prediction.skinType?.type || 'normal';
    const concernMap: Record<string, number> = {};
    (prediction.concerns || []).forEach((c: any) => {
      if (c.active) {
        concernMap[c.code] = c.prob;
      }
    });

    const recommendations = matchProducts(productsData as any, skinType, concernMap);

    return NextResponse.json({
      status: 'success',
      verified: true,
      timestamp: new Date().toISOString(),
      store: 'Toko Annisa Beauty Shop',
      analysis: {
        skinType: prediction.skinType,
        concerns: prediction.concerns,
        confidence: prediction.confidence,
        skinScore: prediction.skinScore || 85,
        livenessMetrics: livenessResult.metrics,
      },
      recommendations: {
        heroProduct: recommendations[0] || null,
        supportingProducts: recommendations.slice(1, 4),
        totalMatched: recommendations.length,
      },
    });
  } catch (error: any) {
    console.error('Error in /api/scan/verify:', error);
    return NextResponse.json(
      { status: 'error', message: 'Terjadi kesalahan server: ' + error.message },
      { status: 500 }
    );
  }
}
