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
        <h2>Structured Text Routines</h2>
        <p>
          Add a Structured Text routine with <strong>+ST</strong> in the program organizer.
          ST routines use the same controller tags as ladder and can be called from ladder with JSR.
        </p>
        <ul>
          <li>Supported statements include assignments, IF / ELSIF / ELSE, CASE, FOR, and WHILE.</li>
          <li>Expressions support math, comparisons, BOOL logic, dynamic array indexing, and dynamic bit indexing.</li>
          <li>Run mode shows live tag values inline beside referenced tags.</li>
          <li>The editor includes syntax coloring, validation, keyword/function autocomplete, and arrow-key selection in autocomplete lists.</li>
        </ul>
      </section>
      <section className="page-card">
        <h2>Structured Text Examples</h2>
        <p>Count the enabled bits in a DINT array element:</p>
        <pre className="help-code">{`found := FALSE;
bitCount := 0;

FOR idx := 0 TO 31 DO
  IF InputWords[0].idx THEN
    found := TRUE;
    bitCount := bitCount + 1;
  END_IF;
END_FOR;`}</pre>
        <p>Use CASE and bitwise helpers:</p>
        <pre className="help-code">{`CASE step OF
  0:
    motor := FALSE;
  1:
    motor := TRUE;
  ELSE
    step := 0;
END_CASE;

masked := BAND(InputWords[0], 16);
shifted := SHL(1, idx);`}</pre>
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
