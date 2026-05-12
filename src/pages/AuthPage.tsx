import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PageShell } from "../components/PageShell";
import { isSupabaseConfigured, missingSupabaseEnv, turnstileSiteKey } from "../lib/supabase";
import { useAuthStore } from "../store/authStore";

interface AuthPageProps {
  theme: "dark" | "light";
  mode: "login" | "signup";
}

export function AuthPage({ theme, mode }: AuthPageProps) {
  const navigate = useNavigate();
  const { user, loading, error, signIn, signUp, signInWithGoogle, clearError } = useAuthStore();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [captchaToken, setCaptchaToken] = useState("");
  const isSignup = mode === "signup";
  const captchaRequired = Boolean(turnstileSiteKey);
  const handleCaptchaExpire = useCallback(() => setCaptchaToken(""), []);

  useEffect(() => {
    clearError();
    setCaptchaToken("");
  }, [clearError, mode]);

  useEffect(() => {
    if (user) navigate("/", { replace: true });
  }, [navigate, user]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (captchaRequired && !captchaToken) return;
    if (isSignup) await signUp(email.trim(), password, captchaToken || undefined);
    else await signIn(email.trim(), password, captchaToken || undefined);
  }

  return (
    <PageShell
      theme={theme}
      eyebrow="Account"
      title={isSignup ? "Create Account" : "Log In"}
      contentClassName="page-content--auth"
    >
      <section className="page-card auth-card">
        {!isSupabaseConfigured ? (
          <div className="auth-config-note">
            <h2>Supabase setup needed</h2>
            <p>
              Add Supabase build environment variables in Cloudflare, then redeploy.
            </p>
            <ul className="auth-config-list">
              <li>
                URL: <code>VITE_SUPABASE_URL</code> or <code>SUPABASE_URL</code>
                {missingSupabaseEnv.url ? " is missing" : " is present"}
              </li>
              <li>
                Publishable key: <code>VITE_SUPABASE_PUBLISHABLE_KEY</code>,{" "}
                <code>VITE_SUPABASE_ANON_KEY</code>,{" "}
                <code>SUPABASE_PUBLISHABLE_KEY</code>, or <code>SUPABASE_ANON_KEY</code>
                {missingSupabaseEnv.anonKey ? " is missing" : " is present"}
              </li>
            </ul>
          </div>
        ) : (
          <>
            <button className="auth-google" type="button" onClick={signInWithGoogle} disabled={loading}>
              <span className="auth-google-mark" aria-hidden="true">G</span>
              Continue with Google
            </button>
            <div className="auth-divider"><span>or</span></div>
            <form className="auth-form" onSubmit={handleSubmit}>
              <label>
                <span>Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  required
                />
              </label>
              <label>
                <span>Password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={isSignup ? "new-password" : "current-password"}
                  minLength={6}
                  required
                />
              </label>
              {captchaRequired ? (
                <TurnstileWidget
                  siteKey={turnstileSiteKey}
                  theme={theme}
                  onVerify={setCaptchaToken}
                  onExpire={handleCaptchaExpire}
                />
              ) : (
                <p className="auth-captcha-note">
                  Turnstile is not configured. Add <code>VITE_TURNSTILE_SITE_KEY</code> to enable CAPTCHA.
                </p>
              )}
              {error && <p className="auth-error">{error}</p>}
              <button className="auth-primary" type="submit" disabled={loading || (captchaRequired && !captchaToken)}>
                {loading ? "Working..." : isSignup ? "Create account" : "Log in"}
              </button>
            </form>
          </>
        )}
        <p className="auth-switch">
          {isSignup ? "Already have an account?" : "Need an account?"}{" "}
          <Link to={isSignup ? "/login" : "/signup"}>
            {isSignup ? "Log in" : "Sign up"}
          </Link>
        </p>
      </section>
    </PageShell>
  );
}

interface TurnstileWindow extends Window {
  turnstile?: {
    render: (
      container: HTMLElement,
      options: {
        sitekey: string;
        theme?: "light" | "dark" | "auto";
        action?: string;
        callback: (token: string) => void;
        "expired-callback": () => void;
        "error-callback": () => void;
      }
    ) => string;
    remove: (widgetId: string) => void;
  };
}

function TurnstileWidget({
  siteKey,
  theme,
  onVerify,
  onExpire,
}: {
  siteKey: string;
  theme: "dark" | "light";
  onVerify: (token: string) => void;
  onExpire: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);

  useEffect(() => {
    const scriptId = "cf-turnstile-script";
    let cancelled = false;

    function renderWidget() {
      const api = (window as TurnstileWindow).turnstile;
      const container = containerRef.current;
      if (cancelled || !api || !container || widgetIdRef.current) return;

      widgetIdRef.current = api.render(container, {
        sitekey: siteKey,
        theme,
        action: "auth",
        callback: onVerify,
        "expired-callback": onExpire,
        "error-callback": onExpire,
      });
    }

    const existing = document.getElementById(scriptId) as HTMLScriptElement | null;
    if (existing) {
      if ((window as TurnstileWindow).turnstile) renderWidget();
      else existing.addEventListener("load", renderWidget, { once: true });
    } else {
      const script = document.createElement("script");
      script.id = scriptId;
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.addEventListener("load", renderWidget, { once: true });
      document.head.appendChild(script);
    }

    return () => {
      cancelled = true;
      const api = (window as TurnstileWindow).turnstile;
      if (api && widgetIdRef.current) {
        api.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [onExpire, onVerify, siteKey, theme]);

  return <div className="auth-turnstile" ref={containerRef} />;
}
