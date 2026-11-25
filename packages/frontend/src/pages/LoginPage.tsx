import { useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useHealth } from '../api/queries';
import { useAuth } from '../auth/AuthContext';

interface LocationState {
  from?: string;
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.71H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.71A5.41 5.41 0 0 1 3.69 9c0-.59.1-1.17.28-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.04l3.01-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}

export function LoginPage() {
  const { status, config, configError, signInWithGoogle } = useAuth();
  const healthQuery = useHealth();
  const location = useLocation();
  const [authError, setAuthError] = useState<string | null>(null);
  const [redirecting, setRedirecting] = useState(false);
  const [copiedUri, setCopiedUri] = useState(false);

  const state = location.state as LocationState | null;
  const returnTo = state?.from ?? '/race';

  if (status === 'authenticated') {
    return <Navigate to={returnTo} replace />;
  }

  const googleReady = config?.googleAuthEnabled === true;
  const googleRedirectUri = config?.cognitoDomain
    ? `${config.cognitoDomain}/oauth2/idpresponse`
    : undefined;

  const handleGoogleLogin = async () => {
    setAuthError(null);
    setRedirecting(true);
    try {
      await signInWithGoogle(returnTo);
    } catch (err) {
      setRedirecting(false);
      setAuthError(err instanceof Error ? err.message : 'Unable to start Google sign-in.');
    }
  };

  const handleCopyRedirectUri = async () => {
    if (!googleRedirectUri) {
      return;
    }
    try {
      await navigator.clipboard.writeText(googleRedirectUri);
      setCopiedUri(true);
      setTimeout(() => setCopiedUri(false), 2000);
    } catch {
      // Ignore clipboard failures in restricted contexts
    }
  };

  return (
    <main className="center-screen">
      <section className="card login-card">
        <span className="badge">Activity Racer</span>
        <h1>Race Your Daily Goals</h1>
        <p className="subtitle">
          Fair, ability-handicapped step &amp; active-calorie races with friends and family, synced
          automatically from Home Assistant.
        </p>

        {configError && (
          <div className="alert alert-error" role="alert">
            <strong>Configuration Error:</strong> {configError}
          </div>
        )}

        {authError && (
          <div className="alert alert-error" role="alert">
            {authError}
          </div>
        )}

        <button
          type="button"
          className="btn-google"
          disabled={status === 'loading' || redirecting || !googleReady}
          onClick={() => void handleGoogleLogin()}
        >
          <GoogleIcon />
          <span>{redirecting ? 'Redirecting to Google...' : 'Continue with Google'}</span>
        </button>

        {status !== 'loading' && config && !googleReady && (
          <div className="alert alert-info setup-box">
            <strong>Google OAuth2 Setup Pending</strong>
            <p>
              The Cognito OAuth domain is live, waiting for your Google Cloud OAuth 2.0 client to be
              wired in. Add this Authorized Redirect URI in Google Cloud Console:
            </p>
            {googleRedirectUri && (
              <div className="copy-row">
                <code className="code-inline">{googleRedirectUri}</code>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => void handleCopyRedirectUri()}
                >
                  {copiedUri ? 'Copied!' : 'Copy'}
                </button>
              </div>
            )}
            <p className="small muted">
              Once added to Cognito, re-deploy with <code>-c enableGoogleAuth=true</code> to enable
              this button.
            </p>
          </div>
        )}

        <p className="login-footnote">
          Secured with Amazon Cognito OAuth 2.0 Authorization Code + PKCE. No passwords stored by
          Activity Racer.
        </p>

        <div className="health-footer">
          {healthQuery.isPending && <span className="muted small">Checking API health...</span>}
          {healthQuery.isSuccess && (
            <span className="health-pill ok">
              API Online · {healthQuery.data.region}
            </span>
          )}
          {healthQuery.isError && (
            <span className="health-pill err">API Unreachable</span>
          )}
        </div>
      </section>
    </main>
  );
}
