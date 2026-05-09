import { PageShell } from "../components/PageShell";

interface AboutPageProps {
  theme: "dark" | "light";
}

export function AboutPage({ theme }: AboutPageProps) {
  return (
    <PageShell theme={theme} eyebrow="PLC Sim Pro" title="About">
      <section className="page-card page-card-large">
        <h2>Studio-style ladder simulation in the browser</h2>
        <p>
          PLC Sim Pro is a static web app for building and testing ladder logic with
          Studio 5000-inspired editing, tags, routines, online edits, and scan behavior.
        </p>
        <p>
          The app runs locally in the browser, so Help and About pages are just routes inside
          the same deployed site.
        </p>
      </section>
    </PageShell>
  );
}
