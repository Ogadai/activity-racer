import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export function AuthCallbackPage() {
  const { completeCallback } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const exchange = async () => {
      try {
        const { returnTo } = await completeCallback(location.search);
        if (!cancelled) {
          navigate(returnTo, { replace: true });
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Sign-in could not be completed.');
        }
      }
    };

    void exchange();
    return () => {
      cancelled = true;
    };
  }, [completeCallback, location.search, navigate]);

  return (
    <main className="center-screen">
      <section className="card compact-card">
        {!error ? (
          <>
            <div className="spinner" aria-hidden="true" />
            <h2>Completing Google Sign-In...</h2>
            <p className="muted">Verifying PKCE challenge and OIDC tokens with Amazon Cognito.</p>
          </>
        ) : (
          <>
            <h2>Sign-In Failed</h2>
            <div className="alert alert-error" role="alert">
              {error}
            </div>
            <Link to="/login" className="btn btn-primary">
              Back to Sign In
            </Link>
          </>
        )}
      </section>
    </main>
  );
}
