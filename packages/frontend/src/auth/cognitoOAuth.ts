import type { RuntimeConfig } from '@activity-racer/shared';

const SESSION_STORAGE_KEY = 'activity_racer_oauth_session_v1';
const PENDING_AUTH_STORAGE_KEY = 'activity_racer_oauth_pending_v1';
const PENDING_AUTH_MAX_AGE_MS = 10 * 60 * 1000;
const REFRESH_SKEW_MS = 60 * 1000;

export interface AuthUser {
  sub: string;
  email?: string;
  name?: string;
}

export interface StoredSession {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  user: AuthUser;
}

interface PendingOAuthRequest {
  state: string;
  verifier: string;
  nonce: string;
  returnTo: string;
  createdAt: number;
}

interface CognitoTokenResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomBase64Url(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function sha256Base64Url(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return bytesToBase64Url(new Uint8Array(digest));
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length < 2) {
    throw new Error('Invalid JWT format.');
  }
  const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json) as Record<string, unknown>;
}

function extractUserFromIdToken(idToken: string): { user: AuthUser; nonce?: string; exp?: number } {
  const payload = decodeJwtPayload(idToken);
  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  if (!sub) {
    throw new Error('ID token is missing the subject (sub) claim.');
  }
  const email = typeof payload.email === 'string' ? payload.email : undefined;
  const name = typeof payload.name === 'string' ? payload.name : undefined;
  const nonce = typeof payload.nonce === 'string' ? payload.nonce : undefined;
  const exp = typeof payload.exp === 'number' ? payload.exp : undefined;
  return { user: { sub, email, name }, nonce, exp };
}

function getCallbackUrl(config: RuntimeConfig): string {
  const callbackPath = config.callbackPath ?? '/auth/callback';
  return `${window.location.origin}${callbackPath}`;
}

function getLogoutUrl(config: RuntimeConfig): string {
  const logoutPath = config.logoutPath ?? '/login';
  return `${window.location.origin}${logoutPath}`;
}

function requireOAuthConfig(config: RuntimeConfig): {
  cognitoDomain: string;
  clientId: string;
} {
  if (!config.cognitoDomain || !config.userPoolClientId) {
    throw new Error('Cognito OAuth configuration is missing from runtime config.');
  }
  return {
    cognitoDomain: config.cognitoDomain.replace(/\/+$/, ''),
    clientId: config.userPoolClientId,
  };
}

export function loadStoredSession(): StoredSession | null {
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as StoredSession;
    if (
      typeof parsed?.idToken !== 'string' ||
      typeof parsed?.accessToken !== 'string' ||
      typeof parsed?.expiresAt !== 'number' ||
      typeof parsed?.user?.sub !== 'string'
    ) {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    return null;
  }
}

export function saveStoredSession(session: StoredSession): void {
  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function clearStoredSession(): void {
  window.localStorage.removeItem(SESSION_STORAGE_KEY);
  window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
  window.sessionStorage.removeItem(PENDING_AUTH_STORAGE_KEY);
}

export function isSessionFresh(session: StoredSession, skewMs = REFRESH_SKEW_MS): boolean {
  return Date.now() + skewMs < session.expiresAt;
}

export function sanitizeReturnTo(target?: string): string {
  if (!target || !target.startsWith('/') || target.startsWith('//') || target.startsWith('/auth/')) {
    return '/race';
  }
  return target;
}

/**
 * Starts the Cognito OAuth 2.0 Authorization Code + PKCE (S256) flow directly to Google.
 */
export async function startGoogleSignIn(config: RuntimeConfig, returnTo?: string): Promise<void> {
  const { cognitoDomain, clientId } = requireOAuthConfig(config);
  if (config.googleAuthEnabled === false) {
    throw new Error(
      'Google Sign-In is not enabled in AWS Cognito yet. Complete the Google OAuth setup steps first.',
    );
  }

  const verifier = randomBase64Url(32);
  const challenge = await sha256Base64Url(verifier);
  const state = randomBase64Url(32);
  const nonce = randomBase64Url(32);

  const pending: PendingOAuthRequest = {
    state,
    verifier,
    nonce,
    returnTo: sanitizeReturnTo(returnTo),
    createdAt: Date.now(),
  };
  window.sessionStorage.setItem(PENDING_AUTH_STORAGE_KEY, JSON.stringify(pending));

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: getCallbackUrl(config),
    scope: 'openid email profile',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    nonce,
    identity_provider: 'Google',
  });

  window.location.assign(`${cognitoDomain}/oauth2/authorize?${params.toString()}`);
}

const inFlightCallbackExchanges = new Map<
  string,
  Promise<{ session: StoredSession; returnTo: string }>
>();

/**
 * Completes the OAuth 2.0 Authorization Code + PKCE callback.
 * Guarded by single-flight per authorization code so React StrictMode double-mounts never exchange twice.
 */
export function completeOAuthCallback(
  config: RuntimeConfig,
  search: string,
): Promise<{ session: StoredSession; returnTo: string }> {
  const params = new URLSearchParams(search);
  const error = params.get('error');
  const errorDescription = params.get('error_description');
  if (error) {
    window.sessionStorage.removeItem(PENDING_AUTH_STORAGE_KEY);
    return Promise.reject(
      new Error(errorDescription ? `${error}: ${errorDescription}` : `OAuth error: ${error}`),
    );
  }

  const code = params.get('code');
  const returnedState = params.get('state');
  if (!code || !returnedState) {
    return Promise.reject(new Error('Missing authorization code or state parameter in callback.'));
  }

  const existing = inFlightCallbackExchanges.get(code);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    const { cognitoDomain, clientId } = requireOAuthConfig(config);
    const rawPending = window.sessionStorage.getItem(PENDING_AUTH_STORAGE_KEY);
    window.sessionStorage.removeItem(PENDING_AUTH_STORAGE_KEY);

    if (!rawPending) {
      throw new Error('Sign-in state was missing or expired. Please try signing in again.');
    }

    const pending = JSON.parse(rawPending) as PendingOAuthRequest;
    if (Date.now() - pending.createdAt > PENDING_AUTH_MAX_AGE_MS) {
      throw new Error('Sign-in request expired. Please try signing in again.');
    }
    if (pending.state !== returnedState) {
      throw new Error('OAuth state mismatch detected. Sign-in aborted for security.');
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: getCallbackUrl(config),
      code_verifier: pending.verifier,
    });

    const tokenRes = await fetch(`${cognitoDomain}/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const payload = (await tokenRes.json().catch(() => ({}))) as CognitoTokenResponse;
    if (!tokenRes.ok || !payload.id_token || !payload.access_token) {
      throw new Error(
        payload.error_description ||
          payload.error ||
          `Token exchange failed (HTTP ${tokenRes.status}).`,
      );
    }

    const { user, nonce, exp } = extractUserFromIdToken(payload.id_token);
    if (nonce !== pending.nonce) {
      throw new Error('OIDC nonce verification failed. Sign-in aborted for security.');
    }

    const expiresInMs = (payload.expires_in ?? 3600) * 1000;
    const expiresAt = exp ? exp * 1000 : Date.now() + expiresInMs;

    const session: StoredSession = {
      idToken: payload.id_token,
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt,
      user,
    };

    saveStoredSession(session);
    return { session, returnTo: sanitizeReturnTo(pending.returnTo) };
  })();

  inFlightCallbackExchanges.set(code, promise);
  void promise.finally(() => {
    setTimeout(() => {
      inFlightCallbackExchanges.delete(code);
    }, 30_000);
  });

  return promise;
}

let inFlightRefresh: Promise<StoredSession> | null = null;

/**
 * Refreshes the ID & access tokens using Cognito's /oauth2/token endpoint.
 */
export async function refreshStoredSession(
  config: RuntimeConfig,
  current: StoredSession,
): Promise<StoredSession> {
  if (inFlightRefresh) {
    return inFlightRefresh;
  }

  inFlightRefresh = (async () => {
    if (!current.refreshToken) {
      clearStoredSession();
      throw new Error('Session expired and no refresh token is available.');
    }

    const { cognitoDomain, clientId } = requireOAuthConfig(config);
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: current.refreshToken,
    });

    const res = await fetch(`${cognitoDomain}/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const payload = (await res.json().catch(() => ({}))) as CognitoTokenResponse;
    if (!res.ok || !payload.id_token || !payload.access_token) {
      clearStoredSession();
      throw new Error(
        payload.error_description ||
          payload.error ||
          `Session refresh failed (HTTP ${res.status}).`,
      );
    }

    const { user, exp } = extractUserFromIdToken(payload.id_token);
    const expiresInMs = (payload.expires_in ?? 3600) * 1000;
    const nextSession: StoredSession = {
      idToken: payload.id_token,
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? current.refreshToken,
      expiresAt: exp ? exp * 1000 : Date.now() + expiresInMs,
      user,
    };

    saveStoredSession(nextSession);
    return nextSession;
  })();

  try {
    return await inFlightRefresh;
  } finally {
    inFlightRefresh = null;
  }
}

/**
 * Revokes the refresh token (best-effort), clears local session storage, and redirects through
 * Cognito's /logout endpoint so the hosted-UI session cookie is also terminated.
 */
export async function signOutAndRedirect(
  config: RuntimeConfig,
  current: StoredSession | null,
): Promise<void> {
  clearStoredSession();

  if (!config.cognitoDomain || !config.userPoolClientId) {
    window.location.assign(getLogoutUrl(config));
    return;
  }

  const cognitoDomain = config.cognitoDomain.replace(/\/+$/, '');
  const clientId = config.userPoolClientId;

  if (current?.refreshToken) {
    try {
      const body = new URLSearchParams({
        client_id: clientId,
        token: current.refreshToken,
      });
      await fetch(`${cognitoDomain}/oauth2/revoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });
    } catch {
      // Best-effort revocation; proceed with Cognito /logout redirect
    }
  }

  const logoutParams = new URLSearchParams({
    client_id: clientId,
    logout_uri: getLogoutUrl(config),
  });
  window.location.assign(`${cognitoDomain}/logout?${logoutParams.toString()}`);
}
