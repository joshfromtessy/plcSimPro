import { PageShell } from "../components/PageShell";

interface HelpPageProps {
  theme: "dark" | "light";
}

export function HelpPage({ theme }: HelpPageProps) {
  const walkthroughVideoId = "";

  return (
    <PageShell theme={theme} eyebrow="Documentation" title="Help">
      <section className="page-card">
        <h2>Video Walkthrough</h2>
        {walkthroughVideoId ? (
          <div className="video-embed">
            <iframe
              src={`https://www.youtube-nocookie.com/embed/${walkthroughVideoId}`}
              title="PLC Sim Pro walkthrough"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
            />
          </div>
        ) : (
          <p>
            This spot is ready for a YouTube walkthrough. Once we have a video ID,
            the Help page can embed it directly here.
          </p>
        )}
      </section>
      <section className="page-card">
        <h2>Getting Started</h2>
        <p>
          Build ladder logic by dragging instructions from the right palette onto a rung.
          Use the left organizer for programs, routines, and tags.
        </p>
      </section>
      <section className="page-card">
        <h2>Run Mode</h2>
        <p>
          Click Run to start scanning. Structural edits in Run mode require entering online edit
          from the rung gutter first, then accepting or cancelling the pending edit.
        </p>
      </section>
      <section className="page-card">
        <h2>Shortcuts</h2>
        <ul>
          <li>Arrow keys move selection between instructions.</li>
          <li>Ctrl+C and Ctrl+V copy and paste instructions.</li>
          <li>Ctrl+Z and Ctrl+Y undo and redo editor changes.</li>
          <li>Delete removes the selected instruction or rung.</li>
        </ul>
      </section>
    </PageShell>
  );
}
