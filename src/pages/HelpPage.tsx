import { PageShell } from "../components/PageShell";

interface HelpPageProps {
  theme: "dark" | "light";
}

const ladderInstructions = [
  ["XIC", "Examine If Closed", "Conducts when the BOOL tag is TRUE."],
  ["XIO", "Examine If Open", "Conducts when the BOOL tag is FALSE. Unassigned contacts do not conduct."],
  ["OTE", "Output Energize", "Writes the rung condition to a BOOL tag each scan."],
  ["OTL", "Output Latch", "Sets a BOOL tag TRUE when the rung is TRUE. It stays latched until an OTU clears it."],
  ["OTU", "Output Unlatch", "Sets a BOOL tag FALSE when the rung is TRUE."],
  ["ONS", "One Shot", "Passes power for one scan on a rising rung condition."],
  ["OSR", "One-Shot Rising", "True for one scan when the tag transitions from FALSE to TRUE."],
  ["OSF", "One-Shot Falling", "True for one scan when the tag transitions from TRUE to FALSE."],
  ["AFI", "Always False", "Always blocks power. Useful for temporarily disabling logic."],
  ["NOP", "No Operation", "Placeholder instruction. It does not change tags."],
];

const compareInstructions = [
  ["EQU", "Equal", "True when Source A equals Source B."],
  ["NEQ", "Not Equal", "True when Source A does not equal Source B."],
  ["LES", "Less Than", "True when Source A is less than Source B."],
  ["LEQ", "Less Than or Equal", "True when Source A is less than or equal to Source B."],
  ["GRT", "Greater Than", "True when Source A is greater than Source B."],
  ["GEQ", "Greater Than or Equal", "True when Source A is greater than or equal to Source B."],
];

const dataInstructions = [
  ["MOV", "Move", "Copies Source into Destination when the rung is TRUE."],
  ["MVM", "Masked Move", "Writes selected bits: Dest = (Source & Mask) | (Dest & ~Mask)."],
  ["ADD", "Add", "Destination = Source A + Source B."],
  ["SUB", "Subtract", "Destination = Source A - Source B."],
  ["MUL", "Multiply", "Destination = Source A * Source B."],
  ["DIV", "Divide", "Destination = Source A / Source B."],
  ["MOD", "Modulo", "Destination = Source A % Source B."],
  ["NEG", "Negate", "Destination = -Source."],
  ["ABS", "Absolute", "Destination = absolute value of Source."],
  ["SQR", "Square Root", "Destination = square root of Source."],
  ["CLR", "Clear", "Sets Destination to 0."],
];

const timerCounterInstructions = [
  ["TON", "Timer On-Delay", "Times while rung is TRUE. DN turns on when ACC reaches PRE."],
  ["TOF", "Timer Off-Delay", "DN is true while enabled, then times after rung goes FALSE."],
  ["RTO", "Retentive Timer On", "Times while rung is TRUE and keeps ACC until reset."],
  ["CTU", "Count Up", "Counts rising rung transitions up toward PRE."],
  ["CTD", "Count Down", "Counts rising rung transitions down toward PRE/zero behavior."],
  ["RES", "Reset", "Clears timer/counter accumulated value and status bits."],
];

function InstructionTable({ rows }: { rows: string[][] }) {
  return (
    <div className="help-table" role="table">
      {rows.map(([code, name, behavior]) => (
        <div className="help-table-row" role="row" key={code}>
          <code>{code}</code>
          <strong>{name}</strong>
          <span>{behavior}</span>
        </div>
      ))}
    </div>
  );
}

export function HelpPage({ theme }: HelpPageProps) {
  return (
    <PageShell theme={theme} eyebrow="Documentation" title="Help">
      <section className="page-card page-card-large">
        <h2>PLC Sim Pro Basics</h2>
        <p>
          PLC Sim Pro is a browser-based Studio 5000 style ladder and Structured Text simulator.
          Build logic with controller tags, scan it in Run mode, and use live highlighting to see
          what is conducting.
        </p>
        <div className="help-callouts">
          <div><strong>Editor</strong><span>Build rungs, tags, routines, and comments.</span></div>
          <div><strong>Run</strong><span>Scan logic continuously and show live values.</span></div>
          <div><strong>Online Edit</strong><span>Double-click the rung gutter in Run mode before editing.</span></div>
        </div>
      </section>

      <details className="page-card help-details" open>
        <summary>Getting Started</summary>
        <ul>
          <li>Create tags from the Tags tab on the left. BOOL tags are used by contacts and coils; numeric tags are used by math, compare, and move instructions.</li>
          <li>Add ladder routines with <strong>+LAD</strong> and Structured Text routines with <strong>+ST</strong>.</li>
          <li>Drag instructions from the right instruction palette onto a rung, or click an instruction to insert near the current selection.</li>
          <li>Drag tags from the tag list onto compatible instruction fields.</li>
          <li>Double-click a rung body to edit its rung comment. Double-click the gutter in Run mode to begin online edit.</li>
        </ul>
      </details>

      <details className="page-card help-details" open>
        <summary>Ladder Instruction Reference</summary>
        <h3>Contacts and Coils</h3>
        <InstructionTable rows={ladderInstructions} />
        <h3>Compare Instructions</h3>
        <InstructionTable rows={compareInstructions} />
        <h3>Move and Math Instructions</h3>
        <InstructionTable rows={dataInstructions} />
        <h3>Timers and Counters</h3>
        <InstructionTable rows={timerCounterInstructions} />
      </details>

      <details className="page-card help-details">
        <summary>Branches, Routines, and JSR</summary>
        <ul>
          <li>Use <strong>Branch</strong> to create parallel paths around contacts or outputs.</li>
          <li>Use <strong>Add Leg</strong> to add another parallel path to an existing branch.</li>
          <li>The first routine in a program is the entry routine. Other routines only scan when called.</li>
          <li><strong>JSR</strong> calls a ladder or Structured Text routine by name when rung power reaches the instruction.</li>
          <li>Subroutines do not run automatically just because they exist in the organizer.</li>
        </ul>
      </details>

      <details className="page-card help-details">
        <summary>Run Mode and Live Values</summary>
        <ul>
          <li>Click <strong>Run</strong> to scan continuously. Click <strong>Stop</strong> to clear scan highlighting.</li>
          <li>Green wires and instructions indicate live power flow or a true live condition.</li>
          <li>XIC is true when its tag is TRUE. XIO is true when its tag is FALSE.</li>
          <li>Output latch instructions show the latched tag state, not just the current rung condition.</li>
          <li>Instruction values for DINT, INT, REAL, TIMER, and COUNTER tags display in run mode where supported.</li>
        </ul>
      </details>

      <details className="page-card help-details">
        <summary>Structured Text</summary>
        <p>
          Structured Text routines use the same controller tags as ladder. They can be called with JSR
          and participate in the same scan.
        </p>
        <ul>
          <li>Supported statements include assignments, IF / ELSIF / ELSE, CASE, FOR, and WHILE.</li>
          <li>Expressions support math, comparisons, BOOL logic, dynamic array indexing, and dynamic bit indexing.</li>
          <li>Supported helper functions include BAND, BOR, BXOR, BNOT, SHL, and SHR.</li>
          <li>Timer calls support TON, TOF, RTO, TONR, and RES using TIMER tags and millisecond presets.</li>
          <li>Autocomplete suggests keywords, functions, and existing tags. Arrow keys move through suggestions.</li>
        </ul>
        <pre className="help-code">{`IF StartPB AND NOT StopPB THEN
  Motor := TRUE;
ELSE
  Motor := FALSE;
END_IF;`}</pre>
        <pre className="help-code">{`CASE Step OF
  0:
    Motor := FALSE;
  1:
    Motor := TRUE;
  ELSE
    Step := 0;
END_CASE;`}</pre>
        <pre className="help-code">{`BitCount := 0;

FOR idx := 0 TO 31 DO
  IF InputWords[0].idx THEN
    BitCount := BitCount + 1;
  END_IF;
END_FOR;`}</pre>
        <pre className="help-code">{`TON(StartDelay, StartPB, 2000);

IF StartDelay.DN THEN
  MotorRun := TRUE;
END_IF;

IF StopPB THEN
  RES(StartDelay);
END_IF;`}</pre>
        <pre className="help-code">{`TONR(RuntimeTimer, MotorRun, 5000);

IF RuntimeTimer.DN THEN
  MaintenanceDue := TRUE;
END_IF;

IF ResetRuntime THEN
  RES(RuntimeTimer);
END_IF;`}</pre>
      </details>

      <details className="page-card help-details">
        <summary>Shortcuts</summary>
        <div className="help-shortcuts">
          <span><kbd>Arrow Keys</kbd> Move selection between instructions</span>
          <span><kbd>Ctrl</kbd> + <kbd>C</kbd> Copy selected instruction</span>
          <span><kbd>Ctrl</kbd> + <kbd>V</kbd> Paste copied instruction</span>
          <span><kbd>Ctrl</kbd> + <kbd>Z</kbd> Undo</span>
          <span><kbd>Ctrl</kbd> + <kbd>Y</kbd> Redo</span>
          <span><kbd>Delete</kbd> Remove selected instruction, leg, or rung</span>
          <span><kbd>Esc</kbd> Clear selection or close an editor popover</span>
        </div>
      </details>

    </PageShell>
  );
}
