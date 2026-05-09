import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";

interface PageShellProps {
  theme: "dark" | "light";
  title: string;
  eyebrow: string;
  children: ReactNode;
}

export function PageShell({ theme, title, eyebrow, children }: PageShellProps) {
  return (
    <div className="app-root page-root" data-theme={theme}>
      <header className="page-header">
        <NavLink className="page-brand" to="/">PLC Sim</NavLink>
        <nav className="page-nav" aria-label="Site">
          <NavLink to="/" end>Editor</NavLink>
          <NavLink to="/help">Help</NavLink>
          <NavLink to="/about">About</NavLink>
        </nav>
      </header>
      <main className="page-content">
        <p className="page-eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {children}
      </main>
    </div>
  );
}
