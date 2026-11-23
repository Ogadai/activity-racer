import crypto from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { HttpError } from './http';

export interface AuthClaims {
  userId: string;
  email?: string;
}

export function getAuthClaims(event: APIGatewayProxyEventV2WithJWTAuthorizer): AuthClaims {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const sub = claims?.sub;

  if (typeof sub !== 'string' || sub.trim().length === 0) {
    throw new HttpError(401, 'Unauthorized: missing subject claim.');
  }

  const email = typeof claims?.email === 'string' ? claims.email : undefined;
  return { userId: sub, email };
}

export function getHeader(event: APIGatewayProxyEventV2, headerName: string): string | undefined {
  const target = headerName.toLowerCase();
  const headers = event.headers ?? {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target && typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) {
    return false;
  }
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function generateWebhookApiKey(): string {
  return `ar_${crypto.randomBytes(24).toString('base64url')}`;
}

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateInviteCode(length = 8): string {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) {
    code += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length];
  }
  return code;
}
