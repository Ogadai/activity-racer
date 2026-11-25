import type { ApiErrorResponse } from '@activity-racer/shared';
import { loadRuntimeConfig } from '../config';

export class ApiError extends Error {
  readonly status: number;
  readonly details?: string;

  constructor(status: number, message: string, details?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

export type TokenProvider = (forceRefresh?: boolean) => Promise<string>;

async function parseErrorResponse(res: Response): Promise<ApiError> {
  const fallback = `Request failed with HTTP ${res.status}`;
  try {
    const body = (await res.json()) as Partial<ApiErrorResponse>;
    return new ApiError(res.status, body.error || fallback, body.details);
  } catch {
    return new ApiError(res.status, fallback);
  }
}

export async function apiRequest<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: unknown;
    getToken?: TokenProvider;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const config = await loadRuntimeConfig();
  const url = `${config.apiUrl}${path.startsWith('/') ? path : `/${path}`}`;
  const method = options.method ?? 'GET';

  const execute = async (forceRefresh: boolean): Promise<Response> => {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    if (options.getToken) {
      const token = await options.getToken(forceRefresh);
      headers.Authorization = `Bearer ${token}`;
    }

    return fetch(url, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
  };

  let res = await execute(false);

  // If Cognito rejected an expired token, attempt one silent refresh before failing
  if (res.status === 401 && options.getToken) {
    try {
      res = await execute(true);
    } catch {
      throw await parseErrorResponse(res);
    }
  }

  if (!res.ok) {
    throw await parseErrorResponse(res);
  }

  return (await res.json()) as T;
}
