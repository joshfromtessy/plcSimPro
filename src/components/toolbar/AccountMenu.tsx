import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuthStore } from "../../store/authStore";

export function AccountMenu() {
  const { user, signOut } = useAuthStore();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const displayName = getUserDisplayName(user);
  const email = user?.email ?? "Signed in";

  useEffect(() => {
    function handlePointerDown(e: PointerEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  if (!user) {
    return (
      <Link className="toolbar-link-btn" to="/login">
        Login
      </Link>
    );
  }

  return (
    <div className="toolbar-menu account-menu" ref={menuRef}>
      <button className="toolbar-btn account-menu-trigger" onClick={() => setOpen((value) => !value)} title={`${displayName} - ${email}`}>
        <span className="account-avatar" aria-hidden="true">{getUserInitial(displayName, email)}</span>
        <span className="account-trigger-text">
          <span className="account-trigger-name">{displayName}</span>
          <span className="account-trigger-email">{email}</span>
        </span>
      </button>
      {open && (
        <div className="toolbar-popover account-popover">
          <div className="account-email" title={`${displayName} - ${email}`}>
            <strong>{displayName}</strong>
            <span>{email}</span>
          </div>
          <Link className="toolbar-menu-row" to="/account" onClick={() => setOpen(false)}>
            Account page
          </Link>
          <button className="toolbar-menu-row danger" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function getUserDisplayName(user: ReturnType<typeof useAuthStore.getState>["user"]): string {
  if (!user) return "Account";
  const metadata = user.user_metadata as Record<string, unknown> | undefined;
  const candidate =
    metadata?.full_name ??
    metadata?.name ??
    metadata?.display_name ??
    user.email?.split("@")[0];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : "Account";
}

function getUserInitial(displayName: string, email: string): string {
  const source = displayName !== "Account" ? displayName : email;
  return source.trim().charAt(0).toUpperCase() || "A";
}
