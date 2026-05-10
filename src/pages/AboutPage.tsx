import { PageShell } from "../components/PageShell";

interface AboutPageProps {
  theme: "dark" | "light";
}

export function AboutPage({ theme }: AboutPageProps) {
  return (
    <PageShell theme={theme} eyebrow="PLC Sim Pro" title="About">
      <section className="page-card page-card-large">
        <h2>A PLC simulator built closer to how professionals actually work</h2>
        <p>
          PLC Sim Pro started from a simple goal: make a browser-based PLC simulator that feels
          closer to a real controller environment, not just a toy ladder editor. The project is
          aimed at people who want to test logic, teach PLC concepts, practice troubleshooting,
          or prototype control sequences without needing a physical controller on the bench.
        </p>
        <p>
          The editor takes inspiration from professional PLC workflows: controller tags,
          ladder routines, Structured Text routines, subroutine calls, online-edit style behavior,
          live rung highlighting, tag watch values, comments, branches, and scan-based execution.
        </p>
      </section>

      <section className="page-card">
        <h2>Why scan behavior matters</h2>
        <p>
          Real PLCs do not execute logic like a normal script that simply runs once from top to
          bottom and stops. They scan repeatedly. Inputs and tags are read, logic is evaluated,
          outputs and internal values are written, and then the process repeats on a task interval.
        </p>
        <p>
          PLC Sim Pro models that cycle deliberately. The simulator tracks scan count, configured
          task period, actual scan delta, and execution time so timing behavior can be reasoned
          about instead of guessed. Timers use elapsed task time, counters react to scan-to-scan
          transitions, and live power flow is drawn from the current scan result.
        </p>
      </section>

      <section className="page-card">
        <h2>Instruction behavior is explicit</h2>
        <p>
          Instructions are grouped by how they behave in a scan. Contact-style instructions such
          as XIC, XIO, and compares decide whether power continues through a rung. Output-style
          instructions such as OTE, OTL, OTU, timers, counters, moves, math, JSR, and NOP execute
          from the current rung condition.
        </p>
        <p>
          That separation is important. It lets the simulator enforce realistic placement rules,
          keep branches predictable, show live state correctly, and avoid ambiguous behavior that
          makes training tools confusing. XIO, latches, masked moves, timers, counters, math, and
          Structured Text all use the same controller tag model so ladder and ST can interact.
        </p>
      </section>

      <section className="page-card">
        <h2>Built for testing and training</h2>
        <div className="about-grid">
          <div>
            <strong>For testing</strong>
            <p>
              Build small control routines, validate sequencing, test latch/unlatch behavior,
              try math and compare logic, and see live tag results without hardware.
            </p>
          </div>
          <div>
            <strong>For training</strong>
            <p>
              Demonstrate scan order, contact truth states, branches, timers, counters,
              online edits, comments, and subroutine calls in a way students can see directly.
            </p>
          </div>
          <div>
            <strong>For professionals</strong>
            <p>
              Use a familiar Studio-style workflow to reason through logic before moving ideas
              into a real controller project.
            </p>
          </div>
        </div>
      </section>

      <section className="page-card">
        <h2>Why this approach is better than a simple visual editor</h2>
        <p>
          A basic ladder drawing tool can show symbols, but it does not teach how a PLC thinks.
          PLC Sim Pro is designed around execution semantics first: scan timing, tag mutation,
          instruction classes, routine calls, and live state. The visuals are there to explain
          the logic, not hide it.
        </p>
        <p>
          That makes the simulator more useful for real learning and practical troubleshooting:
          the same tag can be used in ladder and Structured Text, live values can be inspected
          while scanning, and instruction behavior follows clear rules instead of one-off UI tricks.
        </p>
      </section>

      <section className="page-card page-card-large">
        <h2>About me</h2>
        <p>
          PLC Sim Pro is being built from the perspective of someone who wanted a PLC
          simulator that feels useful to people who actually work with industrial logic. The goal
          is not to make a flashy demo. The goal is to make a practical training and testing tool
          that respects how PLC programmers think: tags, scans, routines, branches, online edits,
          comments, live values, and instruction behavior that makes sense.
        </p>
        <p>
          I want to keep PLC Sim Pro free because learning PLCs should not require expensive
          software just to practice the fundamentals. If the project helps you train, test an idea,
          teach someone, or get more comfortable with ladder and Structured Text, use it. If you
          want to support the work, donations are appreciated, but they are optional.
        </p>
        <p className="about-signature">-Josh</p>
      </section>
    </PageShell>
  );
}
