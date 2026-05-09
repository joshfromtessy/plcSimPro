import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PageShell } from "../components/PageShell";
import { isSupabaseConfigured, missingSupabaseEnv } from "../lib/supabase";
import { useAuthStore } from "../store/authStore";

interface AuthPageProps {
  theme: "dark" | "light";
  mode: "login" | "signup";
}

export function AuthPage({ theme, mode }: AuthPageProps) {
  const navigate = useNavigate();
  const { user, loading, error, signIn, signUp, clearError } = useAuthStore();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const isSignup = mode === "signup";

  useEffect(() => {
    clearError();
  }, [clearError, mode]);

  useEffect(() => {
    if (user) navigate("/", { replace: true });
  }, [navigate, user]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (isSignup) await signUp(email.trim(), password);
    else await signIn(email.trim(), password);
  }

  return (
    <PageShell
      theme={theme}
      eyebrow="Account"
      title={isSignup ? "Create Account" : "Log In"}
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
            {error && <p className="auth-error">{error}</p>}
            <button className="auth-primary" type="submit" disabled={loading}>
              {loading ? "Working..." : isSignup ? "Create account" : "Log in"}
            </button>
          </form>
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
