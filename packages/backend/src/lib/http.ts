import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { ApiErrorResponse } from '@activity-racer/shared';

export class HttpError extends Error {
  readonly statusCode: number;
  readonly details?: string;

  constructor(statusCode: number, message: string, details?: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

export function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  };
}

export function errorResponse(
  statusCode: number,
  error: string,
  details?: string,
): APIGatewayProxyResultV2 {
  const payload: ApiErrorResponse = details ? { error, details } : { error };
  return jsonResponse(statusCode, payload);
}

export function parseJsonBody<T>(event: APIGatewayProxyEventV2): T {
  if (!event.body) {
    throw new HttpError(400, 'Request body is required.');
  }

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new HttpError(400, 'Request body must be a JSON object.');
    }
    return parsed as T;
  } catch (err) {
    if (err instanceof HttpError) {
      throw err;
    }
    throw new HttpError(400, 'Invalid JSON in request body.');
  }
}

export function handleError(err: unknown): APIGatewayProxyResultV2 {
  if (err instanceof HttpError) {
    return errorResponse(err.statusCode, err.message, err.details);
  }
  console.error('Unhandled Lambda error:', err);
  return errorResponse(500, 'Internal server error.');
}
