import { useEffect, useMemo, useRef, useState } from "react";
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
  const [cursorIndex, setCursorIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setSource(routine.structuredText ?? "");
  }, [routine.id, routine.structuredText]);

  const referencedTags = useMemo(
    () => getReferencedTags(source, project.tags),
    [source, project.tags]
  );
  const validationErrors = useMemo(
    () => validateStructuredText(source, project.tags),
    [source, project.tags]
  );
  const currentToken = getTokenAt(source, cursorIndex);
  const tagSuggestions = useMemo(
    () => getTagSuggestions(project.tags, currentToken),
    [project.tags, currentToken]
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

  function updateCursor() {
    setCursorIndex(textareaRef.current?.selectionStart ?? 0);
  }

  function insertTagName(tagName: string) {
    const textarea = textareaRef.current;
    const cursor = textarea?.selectionStart ?? cursorIndex;
    const token = getTokenAt(source, cursor);
    const nextSource = `${source.slice(0, token.start)}${tagName}${source.slice(token.end)}`;
    const nextCursor = token.start + tagName.length;
    setSource(nextSource);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
      setCursorIndex(nextCursor);
    });
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
            ref={textareaRef}
            className="st-textarea"
            spellCheck={false}
            value={source}
            onChange={event => {
              setSource(event.target.value);
              setCursorIndex(event.target.selectionStart);
            }}
            onClick={updateCursor}
            onKeyUp={updateCursor}
            onBlur={commitSource}
            placeholder={"IF StartPB THEN\n  MotorRun := TRUE;\nELSE\n  MotorRun := FALSE;\nEND_IF;"}
          />
          <div className="st-line-live" aria-hidden="true">
            {lineValues.map((value, index) => <div key={index}>{value}</div>)}
          </div>
        </div>

        <aside className="st-live-panel">
          <div className="st-live-title">Tag Suggestions</div>
          {tagSuggestions.length === 0 ? (
            <div className="st-empty">Type a tag name, then click a suggestion to insert it.</div>
          ) : (
            <div className="st-suggestion-list">
              {tagSuggestions.map(tag => (
                <button key={tag.name} type="button" onMouseDown={event => event.preventDefault()} onClick={() => insertTagName(tag.name)}>
                  <span>{tag.name}</span>
                  <em>{tag.dataType}</em>
                </button>
              ))}
            </div>
          )}

          <div className="st-live-title st-live-title--spaced">Validation</div>
          {validationErrors.length === 0 ? (
            <div className="st-valid">No syntax issues found in supported ST subset.</div>
          ) : (
            <div className="st-error-list">
              {validationErrors.map(error => (
                <div key={`${error.line}-${error.message}`} className="st-error">
                  <strong>Line {error.line}</strong>
                  <span>{error.message}</span>
                </div>
              ))}
            </div>
          )}

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

interface StValidationError {
  line: number;
  message: string;
}

function validateStructuredText(source: string, tags: TagDefinition[]): StValidationError[] {
  const errors: StValidationError[] = [];
  const tagNames = new Set(tags.map(tag => tag.name.toUpperCase()));
  let ifDepth = 0;

  stripBlockComments(source).split(/\r?\n/).forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line) return;

    const upper = line.toUpperCase().replace(/;$/, "").trim();
    if (upper === "ELSE") {
      if (ifDepth === 0) errors.push({ line: lineNumber, message: "ELSE without matching IF." });
      return;
    }
    if (upper === "END_IF") {
      if (ifDepth === 0) errors.push({ line: lineNumber, message: "END_IF without matching IF." });
      else ifDepth -= 1;
      return;
    }

    const ifMatch = line.match(/^IF\s+(.+?)\s+THEN\s*;?$/i);
    if (ifMatch) {
      ifDepth += 1;
      validateExpression(ifMatch[1], lineNumber, tagNames, errors);
      return;
    }

    const assignment = line.match(/^([A-Za-z_]\w*(?:\[\d+\])?(?:\.\w+)?)\s*:=\s*(.+?)\s*;?$/);
    if (!assignment) {
      errors.push({ line: lineNumber, message: "Expected assignment or IF/ELSE/END_IF statement." });
      return;
    }

    const targetBase = assignment[1].match(/^([A-Za-z_]\w*)/)?.[1].toUpperCase();
    if (targetBase && !tagNames.has(targetBase)) {
      errors.push({ line: lineNumber, message: `Unknown destination tag "${assignment[1]}".` });
    }
    validateExpression(assignment[2], lineNumber, tagNames, errors);
  });

  if (ifDepth > 0) {
    errors.push({ line: source.split(/\r?\n/).length, message: "Missing END_IF." });
  }

  return errors;
}

function validateExpression(expr: string, line: number, tagNames: Set<string>, errors: StValidationError[]) {
  const keywords = new Set(["IF", "THEN", "ELSE", "END_IF", "TRUE", "FALSE", "AND", "OR", "NOT", "MOD"]);
  const tokens = expr.match(/\b[A-Za-z_]\w*(?:\[\d+\])?(?:\.\w+)?\b/g) ?? [];
  for (const token of tokens) {
    const base = token.match(/^([A-Za-z_]\w*)/)?.[1].toUpperCase();
    if (!base || keywords.has(base)) continue;
    if (!tagNames.has(base)) errors.push({ line, message: `Unknown tag "${token}".` });
  }
}

function stripBlockComments(source: string): string {
  return source.replace(/\(\*[\s\S]*?\*\)/g, "");
}

function getTokenAt(source: string, cursorIndex: number): { text: string; start: number; end: number } {
  const left = source.slice(0, cursorIndex);
  const right = source.slice(cursorIndex);
  const leftMatch = left.match(/[A-Za-z_]\w*$/);
  const rightMatch = right.match(/^\w*/);
  const start = cursorIndex - (leftMatch?.[0].length ?? 0);
  const end = cursorIndex + (rightMatch?.[0].length ?? 0);
  return { text: source.slice(start, end), start, end };
}

function getTagSuggestions(tags: TagDefinition[], token: { text: string }): TagDefinition[] {
  const query = token.text.trim().toLowerCase();
  if (!query) return tags.slice(0, 8);
  return tags
    .filter(tag => tag.name.toLowerCase().includes(query))
    .sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(query) ? 0 : 1;
      const bStarts = b.name.toLowerCase().startsWith(query) ? 0 : 1;
      return aStarts - bStarts || a.name.localeCompare(b.name);
    })
    .slice(0, 8);
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
