import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { RuntimeConfig } from '@activity-racer/shared';
import { loadRuntimeConfig } from '../config';
import {
  clearStoredSession,
  completeOAuthCallback,
  isSessionFresh,
  loadStoredSession,
  refreshStoredSession,
  signOutAndRedirect,
  startGoogleSignIn,
  type AuthUser,
  type StoredSession,
} from './cognitoOAuth';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface AuthContextValue {
  status: AuthStatus;
  config: RuntimeConfig | null;
  configError: string | null;
  user: AuthUser | null;
  getValidToken: (forceRefresh?: boolean) => Promise<string>;
  signInWithGoogle: (returnTo?: string) => Promise<void>;
  completeCallback: (search: string) => Promise<{ returnTo: string }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [session, setSession] = useState<StoredSession | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');

  const configRef = useRef<RuntimeConfig | null>(null);
  const sessionRef = useRef<StoredSession | null>(null);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      try {
        const loadedConfig = await loadRuntimeConfig();
        if (cancelled) {
          return;
        }
        setConfig(loadedConfig);
        configRef.current = loadedConfig;

        const existing = loadStoredSession();
        if (!existing) {
          setSession(null);
          setStatus('unauthenticated');
          return;
        }

        if (isSessionFresh(existing)) {
          setSession(existing);
          setStatus('authenticated');
          return;
        }

        if (existing.refreshToken) {
          try {
            const refreshed = await refreshStoredSession(loadedConfig, existing);
            if (!cancelled) {
              setSession(refreshed);
              setStatus('authenticated');
            }
            return;
          } catch {
            // Fall through to unauthenticated state
          }
        }

        clearStoredSession();
        if (!cancelled) {
          setSession(null);
          setStatus('unauthenticated');
        }
      } catch (err) {
        if (!cancelled) {
          setConfigError(
            err instanceof Error ? err.message : 'Failed to load application configuration.',
          );
          setStatus('unauthenticated');
        }
      }
    };

    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  const getValidToken = useCallback(async (forceRefresh = false): Promise<string> => {
    const activeConfig = configRef.current ?? (await loadRuntimeConfig());
    const current = sessionRef.current ?? loadStoredSession();

    if (!current) {
      setSession(null);
      setStatus('unauthenticated');
      throw new Error('Not authenticated.');
    }

    if (!forceRefresh && isSessionFresh(current)) {
      return current.idToken;
    }

    try {
      const refreshed = await refreshStoredSession(activeConfig, current);
      sessionRef.current = refreshed;
      setSession(refreshed);
      setStatus('authenticated');
      return refreshed.idToken;
    } catch (err) {
      clearStoredSession();
      sessionRef.current = null;
      setSession(null);
      setStatus('unauthenticated');
      throw err;
    }
  }, []);

  const signInWithGoogle = useCallback(async (returnTo?: string): Promise<void> => {
    const activeConfig = configRef.current ?? (await loadRuntimeConfig());
    await startGoogleSignIn(activeConfig, returnTo);
  }, []);

  const completeCallback = useCallback(async (search: string): Promise<{ returnTo: string }> => {
    const activeConfig = configRef.current ?? (await loadRuntimeConfig());
    const result = await completeOAuthCallback(activeConfig, search);
    sessionRef.current = result.session;
    setSession(result.session);
    setStatus('authenticated');
    return { returnTo: result.returnTo };
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    const activeConfig = configRef.current ?? (await loadRuntimeConfig());
    const current = sessionRef.current;
    sessionRef.current = null;
    setSession(null);
    setStatus('unauthenticated');
    await signOutAndRedirect(activeConfig, current);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      config,
      configError,
      user: session?.user ?? null,
      getValidToken,
      signInWithGoogle,
      completeCallback,
      signOut,
    }),
    [status, config, configError, session, getValidToken, signInWithGoogle, completeCallback, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside an AuthProvider.');
  }
  return ctx;
}
