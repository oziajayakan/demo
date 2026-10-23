// app/api/session/challenge/route.ts
import { NextResponse } from 'next/server';
import crypto from 'crypto';

export const runtime = 'nodejs';

const FLASH_COLORS = [
  { hex: '#00F0FF', name: 'Cyan Spektral' },
  { hex: '#FF2A85', name: 'Magenta Spektral' },
  { hex: '#FFB800', name: 'Amber Spektral' },
];

export async function GET() {
  const sessionId = 'ses_' + crypto.randomBytes(8).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');
  const issuedAt = Math.floor(Date.now() / 1000);
  const ttlSeconds = 45;

  // Pick random challenge flash color
  const selectedFlash = FLASH_COLORS[Math.floor(Math.random() * FLASH_COLORS.length)];

  // Create HMAC token
  const secret = process.env.SESSION_SECRET || 'annisa_anti_manipulation_secret_2026';
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${sessionId}:${nonce}:${issuedAt}:${selectedFlash.hex}`);
  const signature = hmac.digest('hex');

  return NextResponse.json({
    status: 'success',
    sessionId,
    nonce,
    issuedAt,
    ttlSeconds,
    signature,
    challenge: {
      type: 'DYNAMIC_SCREEN_FLASH',
      flashColor: selectedFlash.hex,
      flashName: selectedFlash.name,
      durationMs: 160,
    },
    clientPolicies: {
      zeroUpload: true,
      facingModeRequired: 'user',
      burstFrames: 3,
    },
  });
}
