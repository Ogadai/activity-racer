import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const s3 = new S3Client({});
const BUCKET_NAME = process.env.SITE_BUCKET_NAME ?? '';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.ico',
  '.woff',
  '.woff2',
]);

function getExtension(key: string): string {
  const lastSlash = key.lastIndexOf('/');
  const filename = lastSlash >= 0 ? key.slice(lastSlash + 1) : key;
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
}

function cacheControlFor(key: string): string {
  if (key.startsWith('assets/')) {
    return 'public, max-age=31536000, immutable';
  }
  return 'no-store, max-age=0';
}

async function fetchObject(key: string): Promise<APIGatewayProxyResultV2 | null> {
  try {
    const res = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
      }),
    );

    if (!res.Body) {
      return null;
    }

    const ext = getExtension(key);
    const contentType = MIME_TYPES[ext] ?? res.ContentType ?? 'application/octet-stream';
    const isBinary = BINARY_EXTENSIONS.has(ext);
    const bytes = await res.Body.transformToByteArray();

    return {
      statusCode: 200,
      headers: {
        'content-type': contentType,
        'cache-control': cacheControlFor(key),
      },
      body: isBinary ? Buffer.from(bytes).toString('base64') : Buffer.from(bytes).toString('utf-8'),
      isBase64Encoded: isBinary,
    };
  } catch (err: unknown) {
    const code = (err as { name?: string; $metadata?: { httpStatusCode?: number } })?.name;
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (code === 'NoSuchKey' || code === 'NotFound' || status === 404 || status === 403) {
      return null;
    }
    throw err;
  }
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  if (!BUCKET_NAME) {
    return { statusCode: 500, body: 'SITE_BUCKET_NAME is not configured' };
  }

  const rawPath = event.rawPath ?? '/';
  if (rawPath.includes('..') || rawPath.includes('\0')) {
    return { statusCode: 400, body: 'Invalid path' };
  }

  const trimmed = rawPath.replace(/^\/+/, '');
  const requestedKey = trimmed === '' ? 'index.html' : trimmed;

  const direct = await fetchObject(requestedKey);
  if (direct) {
    return direct;
  }

  // SPA client-side routing fallback: only fall back to index.html for extensionless routes
  const hasFileExtension = getExtension(requestedKey) !== '';
  if (!hasFileExtension) {
    const indexResponse = await fetchObject('index.html');
    if (indexResponse) {
      return indexResponse;
    }
  }

  return {
    statusCode: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: 'Not Found',
  };
};
