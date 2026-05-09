import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuthStore } from "../../store/authStore";

export function AccountMenu() {
  const { user, signOut } = useAuthStore();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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
      <button className="toolbar-btn account-menu-trigger" onClick={() => setOpen((value) => !value)}>
        Account
      </button>
      {open && (
        <div className="toolbar-popover account-popover">
          <div className="account-email" title={user.email ?? "Signed in"}>
            {user.email ?? "Signed in"}
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
