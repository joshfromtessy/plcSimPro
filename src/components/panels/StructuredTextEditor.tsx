import { useEffect, useMemo, useState } from "react";
import type { Routine, TagDefinition } from "../../model/types";
import { useProjectStore } from "../../store/projectStore";
import { useSimulationStore } from "../../store/simulationStore";
import "./StructuredTextEditor.css";

interface StructuredTextEditorProps {
  routine: Routine;
}

export function StructuredTextEditor({ routine }: StructuredTextEditorProps) {
  const { project, setStructuredText } = useProjectStore();
  const mode = useSimulationStore(state => state.mode);
  const [source, setSource] = useState(routine.structuredText ?? "");

  useEffect(() => {
    setSource(routine.structuredText ?? "");
  }, [routine.id, routine.structuredText]);

  const referencedTags = useMemo(
    () => getReferencedTags(source, project.tags),
    [source, project.tags]
  );

  const lines = source.split(/\r?\n/);
  const lineValues = useMemo(
    () => lines.map(line => getAssignmentTarget(line)).map(target => {
      const tag = target ? findTag(project.tags, target) : null;
      return tag && target ? `${target} = ${formatTagValue(tag, target)}` : "";
    }),
    [source, project.tags]
  );

  function commitSource() {
    if (source !== (routine.structuredText ?? "")) {
      setStructuredText(routine.id, source);
    }
  }

  return (
    <main className="st-editor">
      <div className="st-header">
        <div>
          <span className="st-routine-name">{routine.name}</span>
          <span className="st-routine-type">Structured Text</span>
        </div>
        <div className={`st-run-state st-run-state--${mode}`}>
          {mode === "running" ? "Live values" : "Stopped"}
        </div>
      </div>

      <div className="st-body">
        <div className="st-code-shell">
          <div className="st-line-numbers" aria-hidden="true">
            {lines.map((_, index) => <div key={index}>{index + 1}</div>)}
          </div>
          <textarea
            className="st-textarea"
            spellCheck={false}
            value={source}
            onChange={event => setSource(event.target.value)}
            onBlur={commitSource}
            placeholder={"IF StartPB THEN\n  MotorRun := TRUE;\nELSE\n  MotorRun := FALSE;\nEND_IF;"}
          />
          <div className="st-line-live" aria-hidden="true">
            {lineValues.map((value, index) => <div key={index}>{value}</div>)}
          </div>
        </div>

        <aside className="st-live-panel">
          <div className="st-live-title">Referenced Tags</div>
          {referencedTags.length === 0 ? (
            <div className="st-empty">Use existing tags in ST, then their live values show here.</div>
          ) : (
            referencedTags.map(tag => (
              <div key={tag.name} className="st-live-tag">
                <div>
                  <span className={`st-tag-type st-tag-type--${tag.dataType.toLowerCase()}`}>{tag.dataType}</span>
                  <span className="st-tag-name">{tag.name}</span>
                </div>
                <span className="st-tag-value">{formatTagValue(tag, tag.name)}</span>
              </div>
            ))
          )}
        </aside>
      </div>
    </main>
  );
}

function getReferencedTags(source: string, tags: TagDefinition[]): TagDefinition[] {
  const names = new Set(source.match(/\b[A-Za-z_]\w*\b/g) ?? []);
  const keywords = new Set(["IF", "THEN", "ELSE", "END_IF", "TRUE", "FALSE", "AND", "OR", "NOT", "MOD"]);
  return tags.filter(tag => names.has(tag.name) && !keywords.has(tag.name.toUpperCase()));
}

function getAssignmentTarget(line: string): string | null {
  const match = line.trim().match(/^([A-Za-z_]\w*(?:\[\d+\])?(?:\.\w+)?)\s*:=/);
  return match?.[1] ?? null;
}

function findTag(tags: TagDefinition[], ref: string): TagDefinition | null {
  const base = ref.match(/^([A-Za-z_]\w*)/)?.[1];
  return base ? tags.find(tag => tag.name === base) ?? null : null;
}

function formatTagValue(tag: TagDefinition, ref: string): string {
  if (tag.dataType === "TIMER" && tag.timerData) {
    const member = ref.split(".")[1]?.toUpperCase();
    if (member === "PRE") return String(tag.timerData.preset);
    if (member === "ACC") return String(tag.timerData.accum);
    if (member === "EN") return String(tag.timerData.en);
    if (member === "TT") return String(tag.timerData.tt);
    if (member === "DN") return String(tag.timerData.dn);
    return `PRE ${tag.timerData.preset} ACC ${tag.timerData.accum}`;
  }
  if (tag.dataType === "COUNTER" && tag.counterData) {
    const member = ref.split(".")[1]?.toUpperCase();
    if (member === "PRE") return String(tag.counterData.preset);
    if (member === "ACC") return String(tag.counterData.accum);
    if (member === "DN") return String(tag.counterData.dn);
    return `PRE ${tag.counterData.preset} ACC ${tag.counterData.accum}`;
  }
  if (Array.isArray(tag.value)) return `[${tag.value.join(", ")}]`;
  return String(tag.value);
}
