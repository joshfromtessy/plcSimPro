import { Navigate } from "react-router-dom";
import { PageShell } from "../components/PageShell";
import { useAuthStore } from "../store/authStore";

interface AccountPageProps {
  theme: "dark" | "light";
}

export function AccountPage({ theme }: AccountPageProps) {
  const { user, loading, signOut } = useAuthStore();

  if (!loading && !user) {
    return <Navigate to="/login" replace />;
  }

  return (
    <PageShell theme={theme} eyebrow="Account" title="Account">
      <section className="page-card auth-card">
        <h2>Signed in</h2>
        <p>{user?.email}</p>
        <button className="auth-primary" onClick={signOut} disabled={loading}>
          Sign out
        </button>
      </section>
    </PageShell>
  );
}
