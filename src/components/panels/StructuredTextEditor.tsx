import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Routine, TagDefinition } from "../../model/types";
import { useProjectStore } from "../../store/projectStore";
import { useSimulationStore } from "../../store/simulationStore";
import "./StructuredTextEditor.css";

interface StructuredTextEditorProps {
  routine: Routine;
}

type StSuggestion = {
  label: string;
  insertText: string;
  detail: string;
  kind: "keyword" | "function" | "operator" | "tag";
};

export function StructuredTextEditor({ routine }: StructuredTextEditorProps) {
  const { project, setStructuredText } = useProjectStore();
  const mode = useSimulationStore(state => state.mode);
  const [source, setSource] = useState(routine.structuredText ?? "");
  const [cursorIndex, setCursorIndex] = useState(0);
  const [editorFocused, setEditorFocused] = useState(false);
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [autocompleteDismissedToken, setAutocompleteDismissedToken] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setSource(routine.structuredText ?? "");
  }, [routine.id, routine.structuredText]);

  const validationErrors = useMemo(
    () => validateStructuredText(source, project.tags),
    [source, project.tags]
  );
  const highlightedSource = useMemo(
    () => renderSyntaxPreview(source, project.tags, mode === "running"),
    [source, project.tags, mode]
  );
  const currentToken = getTokenAt(source, cursorIndex);
  const autocompleteSuggestions = useMemo(
    () => getStructuredTextSuggestions(project.tags, currentToken),
    [project.tags, currentToken]
  );

  const lines = source.split(/\r?\n/);
  const autocompletePosition = getAutocompletePosition(source, currentToken.start);
  const showAutocomplete =
    editorFocused &&
    currentToken.text.length > 0 &&
    currentToken.text !== autocompleteDismissedToken &&
    autocompleteSuggestions.length > 0;

  useEffect(() => {
    setAutocompleteIndex(0);
  }, [currentToken.text]);

  useEffect(() => {
    if (autocompleteIndex >= autocompleteSuggestions.length) {
      setAutocompleteIndex(Math.max(0, autocompleteSuggestions.length - 1));
    }
  }, [autocompleteIndex, autocompleteSuggestions.length]);

  function commitSource() {
    if (source !== (routine.structuredText ?? "")) {
      setStructuredText(routine.id, source);
    }
  }

  function updateCursor() {
    setCursorIndex(textareaRef.current?.selectionStart ?? 0);
    setAutocompleteDismissedToken("");
  }

  function insertSuggestion(suggestion: StSuggestion) {
    const textarea = textareaRef.current;
    const cursor = textarea?.selectionStart ?? cursorIndex;
    const token = getTokenAt(source, cursor);
    const nextSource = `${source.slice(0, token.start)}${suggestion.insertText}${source.slice(token.end)}`;
    const nextCursor = token.start + getSuggestionCursorOffset(suggestion);
    setSource(nextSource);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
      setCursorIndex(nextCursor);
    });
  }

  function handleEditorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (showAutocomplete && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setAutocompleteIndex(index => {
        const direction = event.key === "ArrowDown" ? 1 : -1;
        return (index + direction + autocompleteSuggestions.length) % autocompleteSuggestions.length;
      });
      return;
    }

    if (showAutocomplete && event.key === "Escape") {
      event.preventDefault();
      setAutocompleteDismissedToken(currentToken.text);
      return;
    }

    if (showAutocomplete && (event.key === "Tab" || event.key === "Enter") && autocompleteSuggestions[autocompleteIndex]) {
      event.preventDefault();
      insertSuggestion(autocompleteSuggestions[autocompleteIndex]);
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
          <div className="st-code-editor">
            <pre className="st-highlight" aria-hidden="true">
              {source ? highlightedSource : <span className="st-placeholder">IF StartPB THEN{"\n"}  MotorRun := TRUE;{"\n"}ELSE{"\n"}  MotorRun := FALSE;{"\n"}END_IF;</span>}
            </pre>
            <textarea
              ref={textareaRef}
              className="st-textarea"
              spellCheck={false}
              value={source}
              onChange={event => {
                setSource(event.target.value);
                setCursorIndex(event.target.selectionStart);
                setAutocompleteDismissedToken("");
              }}
              onClick={updateCursor}
              onKeyDown={handleEditorKeyDown}
              onKeyUp={updateCursor}
              onFocus={() => setEditorFocused(true)}
              onBlur={() => {
                setEditorFocused(false);
                commitSource();
              }}
              placeholder={"IF StartPB THEN\n  MotorRun := TRUE;\nELSE\n  MotorRun := FALSE;\nEND_IF;"}
            />
            {showAutocomplete && (
              <div
                className="st-autocomplete"
                style={{ left: autocompletePosition.left, top: autocompletePosition.top }}
              >
                {autocompleteSuggestions.map((suggestion, index) => (
                  <button
                    key={`${suggestion.kind}-${suggestion.label}`}
                    className={`${index === autocompleteIndex ? "st-autocomplete-active" : ""} st-autocomplete-item--${suggestion.kind}`}
                    type="button"
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => insertSuggestion(suggestion)}
                  >
                    <span>{suggestion.label}</span>
                    <em>{suggestion.detail}</em>
                  </button>
                ))}
                <div className="st-autocomplete-hint">Up/Down selects, Enter/Tab inserts, Esc closes</div>
              </div>
            )}
          </div>
        </div>
        <div className="st-validation-strip">
          {validationErrors.length === 0 ? (
            <span className="st-valid">No syntax issues found in supported ST subset.</span>
          ) : (
            validationErrors.map(error => (
              <span key={`${error.line}-${error.message}`} className="st-error-inline">
                Line {error.line}: {error.message}
              </span>
            ))
          )}
        </div>
      </div>
    </main>
  );
}

function getReferencedTags(source: string, tags: TagDefinition[]): TagDefinition[] {
  const names = new Set(source.match(/\b[A-Za-z_]\w*\b/g) ?? []);
  const keywords = getStructuredTextKeywords();
  return tags.filter(tag => names.has(tag.name) && !keywords.has(tag.name.toUpperCase()));
}

interface StValidationError {
  line: number;
  message: string;
}

function validateStructuredText(source: string, tags: TagDefinition[]): StValidationError[] {
  const errors: StValidationError[] = [];
  const tagNames = new Set(tags.map(tag => tag.name.toUpperCase()));
  const tagsByName = new Map(tags.map(tag => [tag.name.toUpperCase(), tag]));
  const blockStack: Array<{ type: "IF" | "WHILE" | "FOR" | "CASE"; line: number }> = [];

  stripBlockComments(source).split(/\r?\n/).forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line) return;

    const upper = line.toUpperCase().replace(/;$/, "").trim();
    if (upper === "ELSE") {
      const active = blockStack.at(-1)?.type;
      if (active !== "IF" && active !== "CASE") errors.push({ line: lineNumber, message: "ELSE without matching IF or CASE." });
      return;
    }

    const elsifMatch = line.match(/^ELSIF\s+(.+?)\s+THEN\s*;?$/i);
    if (elsifMatch) {
      if (blockStack.at(-1)?.type !== "IF") {
        errors.push({ line: lineNumber, message: "ELSIF without matching IF." });
      }
      validateExpression(elsifMatch[1], lineNumber, tagNames, tagsByName, errors);
      return;
    }

    if (upper === "END_IF" || upper === "END_WHILE" || upper === "END_FOR" || upper === "END_CASE") {
      const expected = upper.replace("END_", "") as "IF" | "WHILE" | "FOR" | "CASE";
      const active = blockStack.pop();
      if (!active || active.type !== expected) errors.push({ line: lineNumber, message: `${upper} without matching ${expected}.` });
      return;
    }

    const ifMatch = line.match(/^IF\s+(.+?)\s+THEN\s*;?$/i);
    if (ifMatch) {
      blockStack.push({ type: "IF", line: lineNumber });
      validateExpression(ifMatch[1], lineNumber, tagNames, tagsByName, errors);
      return;
    }

    const whileMatch = line.match(/^WHILE\s+(.+?)\s+DO\s*;?$/i);
    if (whileMatch) {
      blockStack.push({ type: "WHILE", line: lineNumber });
      validateExpression(whileMatch[1], lineNumber, tagNames, tagsByName, errors);
      return;
    }

    const forMatch = line.match(/^FOR\s+([A-Za-z_]\w*(?:\[[^\]]+\])?(?:\.\w+)?)\s*:=\s*(.+?)\s+TO\s+(.+?)(?:\s+BY\s+(.+?))?\s+DO\s*;?$/i);
    if (forMatch) {
      blockStack.push({ type: "FOR", line: lineNumber });
      validateDestination(forMatch[1], lineNumber, tagNames, errors);
      validateExpression(forMatch[1], lineNumber, tagNames, tagsByName, errors);
      validateExpression(forMatch[2], lineNumber, tagNames, tagsByName, errors);
      validateExpression(forMatch[3], lineNumber, tagNames, tagsByName, errors);
      if (forMatch[4]) {
        validateExpression(forMatch[4], lineNumber, tagNames, tagsByName, errors);
        if (/^0(?:\.0+)?$/.test(forMatch[4].trim())) errors.push({ line: lineNumber, message: "FOR BY step cannot be 0." });
      }
      return;
    }

    const caseMatch = line.match(/^CASE\s+(.+?)\s+OF\s*;?$/i);
    if (caseMatch) {
      blockStack.push({ type: "CASE", line: lineNumber });
      validateExpression(caseMatch[1], lineNumber, tagNames, tagsByName, errors);
      return;
    }

    const caseBranch = line.match(/^(.+?)\s*:(?!=)\s*(.*)$/);
    if (caseBranch && blockStack.at(-1)?.type === "CASE") {
      caseBranch[1].split(",").forEach(label => {
        label.split("..").forEach(part => validateExpression(part.trim(), lineNumber, tagNames, tagsByName, errors));
      });
      if (caseBranch[2].trim()) validateStructuredTextStatement(caseBranch[2].trim(), lineNumber, tagNames, tagsByName, errors);
      return;
    }

    validateStructuredTextStatement(line, lineNumber, tagNames, tagsByName, errors);
  });

  for (const block of blockStack.reverse()) {
    errors.push({ line: block.line, message: `Missing END_${block.type}.` });
  }

  return errors;
}

function validateStructuredTextStatement(
  line: string,
  lineNumber: number,
  tagNames: Set<string>,
  tagsByName: Map<string, TagDefinition>,
  errors: StValidationError[]
) {
    const timerCall = line.match(/^(TON|TOF|RTO|TONR|RES)\s*\((.*)\)\s*;?$/i);
    if (timerCall) {
      validateTimerCall(timerCall[1].toUpperCase(), timerCall[2], lineNumber, tagNames, tagsByName, errors);
      return;
    }

    const assignment = line.match(/^([A-Za-z_]\w*(?:\[[^\]]+\])?(?:\.\w+)?)\s*:=\s*(.+?)\s*;?$/);
    if (!assignment) {
      errors.push({ line: lineNumber, message: "Expected assignment, timer call, IF, CASE, FOR, or WHILE statement." });
      return;
    }

    validateDestination(assignment[1], lineNumber, tagNames, errors);
    validateExpression(assignment[1], lineNumber, tagNames, tagsByName, errors);
    validateExpression(assignment[2], lineNumber, tagNames, tagsByName, errors);
}

function validateTimerCall(
  type: string,
  argsText: string,
  lineNumber: number,
  tagNames: Set<string>,
  tagsByName: Map<string, TagDefinition>,
  errors: StValidationError[]
) {
  const args = splitStructuredTextArguments(argsText);
  const expected = type === "RES" ? 1 : 3;
  if (args.length < expected) {
    errors.push({
      line: lineNumber,
      message: type === "RES"
        ? "RES expects RES(TimerOrCounterTag)."
        : `${type} expects ${type}(TimerTag, EnableExpr, PresetMs).`,
    });
    return;
  }

  const tagName = args[0] ?? "";
  const tagBase = tagName.match(/^([A-Za-z_]\w*)/)?.[1].toUpperCase();
  const tag = tagBase ? tagsByName.get(tagBase) : undefined;
  if (!tagBase || !tagNames.has(tagBase)) {
    errors.push({ line: lineNumber, message: `Unknown timer tag "${tagName}".` });
  } else if (type === "RES") {
    if (tag?.dataType !== "TIMER" && tag?.dataType !== "COUNTER") {
      errors.push({ line: lineNumber, message: "RES target must be a TIMER or COUNTER tag." });
    }
  } else if (tag?.dataType !== "TIMER") {
    errors.push({ line: lineNumber, message: `${type} target must be a TIMER tag.` });
  }

  if (type !== "RES") {
    validateExpression(args[1] ?? "", lineNumber, tagNames, tagsByName, errors);
    validateExpression(args[2] ?? "", lineNumber, tagNames, tagsByName, errors);
  }
}

function validateDestination(target: string, lineNumber: number, tagNames: Set<string>, errors: StValidationError[]) {
  const targetBase = target.match(/^([A-Za-z_]\w*)/)?.[1].toUpperCase();
  if (targetBase && !tagNames.has(targetBase)) {
    errors.push({ line: lineNumber, message: `Unknown destination tag "${target}".` });
  }
}

function validateExpression(
  expr: string,
  line: number,
  tagNames: Set<string>,
  tagsByName: Map<string, TagDefinition>,
  errors: StValidationError[]
) {
  const keywords = getStructuredTextKeywords();
  const tokens = expr.match(/\b[A-Za-z_]\w*(?:\[[^\]]+\])?(?:\.\w+)?\b/g) ?? [];
  for (const token of tokens) {
    const base = token.match(/^([A-Za-z_]\w*)/)?.[1].toUpperCase();
    if (!base || keywords.has(base)) continue;
    const tag = tagsByName.get(base);
    if (!tagNames.has(base)) {
      errors.push({ line, message: `Unknown tag "${token}".` });
      continue;
    }
    const indexExpr = token.match(/\[([^\]]+)\]/)?.[1];
    if (indexExpr && !/^\d+$/.test(indexExpr.trim())) {
      validateExpression(indexExpr, line, tagNames, tagsByName, errors);
    }
    const suffix = token.match(/\.(\w+)$/)?.[1];
    if (suffix && !/^\d+$/.test(suffix)) {
      const member = suffix.toUpperCase();
      const knownTimerMember = tag?.dataType === "TIMER" && ["PRE", "ACC", "EN", "TT", "DN"].includes(member);
      const knownCounterMember = tag?.dataType === "COUNTER" && ["PRE", "ACC", "CU", "CD", "DN", "OV", "UN"].includes(member);
      const dynamicWordBit = tag?.dataType === "DINT" || tag?.dataType === "INT";
      if (dynamicWordBit) validateExpression(suffix, line, tagNames, tagsByName, errors);
      if (!knownTimerMember && !knownCounterMember && !dynamicWordBit && !tagNames.has(member)) {
        errors.push({ line, message: `Unknown member or bit index "${suffix}" on "${base}".` });
      }
    }
  }
}

function stripBlockComments(source: string): string {
  return source.replace(/\(\*[\s\S]*?\*\)/g, "");
}

function splitStructuredTextArguments(argsText: string): string[] {
  const args: string[] = [];
  let current = "";
  let depth = 0;
  for (const char of argsText) {
    if (char === "(" || char === "[") depth += 1;
    if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim() || argsText.trim()) args.push(current.trim());
  return args;
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

function getStructuredTextSuggestions(tags: TagDefinition[], token: { text: string }): StSuggestion[] {
  const query = token.text.trim().toLowerCase();
  if (!query) return [];

  const languageSuggestions = getStructuredTextLanguageSuggestions()
    .filter(suggestion => suggestion.label.toLowerCase().startsWith(query));
  const tagSuggestions = tags
    .filter(tag => tag.name.toLowerCase().includes(query))
    .map<StSuggestion>(tag => ({
      label: tag.name,
      insertText: tag.name,
      detail: tag.dataType,
      kind: "tag",
    }))
    .sort((a, b) => {
      const aStarts = a.label.toLowerCase().startsWith(query) ? 0 : 1;
      const bStarts = b.label.toLowerCase().startsWith(query) ? 0 : 1;
      return aStarts - bStarts || a.label.localeCompare(b.label);
    });

  return [...languageSuggestions, ...tagSuggestions].slice(0, 8);
}

function getStructuredTextLanguageSuggestions(): StSuggestion[] {
  return [
    {
      label: "IF",
      insertText: "IF  THEN\n  \nEND_IF;",
      detail: "statement",
      kind: "keyword",
    },
    {
      label: "ELSIF",
      insertText: "ELSIF  THEN",
      detail: "branch",
      kind: "keyword",
    },
    {
      label: "ELSE",
      insertText: "ELSE",
      detail: "branch",
      kind: "keyword",
    },
    {
      label: "CASE",
      insertText: "CASE  OF\n  0:\n    \n  ELSE\n    \nEND_CASE;",
      detail: "statement",
      kind: "keyword",
    },
    {
      label: "FOR",
      insertText: "FOR idx := 0 TO 0 DO\n  \nEND_FOR;",
      detail: "loop",
      kind: "keyword",
    },
    {
      label: "WHILE",
      insertText: "WHILE  DO\n  \nEND_WHILE;",
      detail: "loop",
      kind: "keyword",
    },
    { label: "TRUE", insertText: "TRUE", detail: "literal", kind: "keyword" },
    { label: "FALSE", insertText: "FALSE", detail: "literal", kind: "keyword" },
    { label: "AND", insertText: "AND", detail: "boolean", kind: "operator" },
    { label: "OR", insertText: "OR", detail: "boolean", kind: "operator" },
    { label: "NOT", insertText: "NOT", detail: "boolean", kind: "operator" },
    { label: "MOD", insertText: "MOD", detail: "math", kind: "operator" },
    { label: "TON", insertText: "TON(TimerTag, EnableExpr, 1000);", detail: "timer on-delay", kind: "function" },
    { label: "TOF", insertText: "TOF(TimerTag, EnableExpr, 1000);", detail: "timer off-delay", kind: "function" },
    { label: "RTO", insertText: "RTO(TimerTag, EnableExpr, 1000);", detail: "retentive timer", kind: "function" },
    { label: "TONR", insertText: "TONR(TimerTag, EnableExpr, 1000);", detail: "Studio retentive timer", kind: "function" },
    { label: "RES", insertText: "RES(TimerTag);", detail: "reset timer/counter", kind: "function" },
    ...["ABS", "SQR", "SQRT", "MIN", "MAX", "LIMIT", "BAND", "BOR", "BXOR", "BNOT", "SHL", "SHR"].map<StSuggestion>(name => ({
      label: name,
      insertText: `${name}()`,
      detail: "function",
      kind: "function",
    })),
  ];
}

function getSuggestionCursorOffset(suggestion: StSuggestion): number {
  const marker = suggestion.insertText.indexOf("  ");
  if (marker >= 0) return marker + 1;
  const paren = suggestion.insertText.indexOf("()");
  if (paren >= 0) return paren + 1;
  return suggestion.insertText.length;
}

function getAutocompletePosition(source: string, tokenStart: number): { left: number; top: number } {
  const before = source.slice(0, tokenStart);
  const line = before.split(/\r?\n/).length - 1;
  const column = before.length - Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r")) - 1;
  return {
    left: Math.min(520, 16 + column * 8),
    top: 16 + line * 22 + 24,
  };
}

function renderSyntaxPreview(source: string, tags: TagDefinition[], showLiveValues: boolean): ReactNode[] {
  const tagNames = new Set(tags.map(tag => tag.name.toUpperCase()));
  const tagsByName = new Map(tags.map(tag => [tag.name.toUpperCase(), tag]));
  const lines = source.split(/\r?\n/);
  return lines.flatMap((line, lineIndex) => [
    <span key={`l-${lineIndex}`} className="st-preview-line">
      {renderSyntaxLine(line, tagNames, tagsByName, showLiveValues)}
    </span>,
    lineIndex < lines.length - 1 ? "\n" : "",
  ]);
}

function renderSyntaxLine(
  line: string,
  tagNames: Set<string>,
  tagsByName: Map<string, TagDefinition>,
  showLiveValues: boolean
): ReactNode[] {
  const commentIndex = line.indexOf("//");
  const code = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
  const comment = commentIndex >= 0 ? line.slice(commentIndex) : "";
  const parts: ReactNode[] = [];
  const tokenPattern = /\b[A-Za-z_]\w*(?:\[[^\]]+\])?(?:\.\w+)?\b|\d+(?:\.\d+)?|\.\.|:=|<>|<=|>=|[=+\-*/():;]/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(code)) !== null) {
    if (match.index > cursor) parts.push(code.slice(cursor, match.index));
    parts.push(renderSyntaxToken(match[0], tagNames, tagsByName, showLiveValues, `${match.index}-${match[0]}`));
    cursor = match.index + match[0].length;
  }
  if (cursor < code.length) parts.push(code.slice(cursor));
  if (comment) parts.push(<span key="comment" className="st-token-comment">{comment}</span>);
  return parts;
}

function renderSyntaxToken(
  token: string,
  tagNames: Set<string>,
  tagsByName: Map<string, TagDefinition>,
  showLiveValues: boolean,
  key: string
): ReactNode {
  const upper = token.toUpperCase();
  if (getStructuredTextControlKeywords().has(upper)) {
    return <span key={key} className="st-token-keyword">{token}</span>;
  }
  if (getStructuredTextFunctionNames().has(upper)) {
    return <span key={key} className="st-token-function">{token}</span>;
  }
  if (getStructuredTextOperatorKeywords().has(upper)) {
    return <span key={key} className="st-token-operator st-token-operator-keyword">{token}</span>;
  }
  if (upper === "TRUE" || upper === "FALSE") {
    return <span key={key} className="st-token-literal">{token}</span>;
  }
  if (/^\d/.test(token)) return <span key={key} className="st-token-number">{token}</span>;
  if ([":=", "<>", "<=", ">=", "..", "=", "+", "-", "*", "/", "(", ")", ":", ";"].includes(token)) {
    return <span key={key} className="st-token-operator">{token}</span>;
  }
  const base = token.match(/^([A-Za-z_]\w*)/)?.[1].toUpperCase();
  if (base && tagNames.has(base)) {
    const tag = tagsByName.get(base);
    return (
      <span key={key} className="st-token-tag-wrap">
        <span className="st-token-tag">{token}</span>
        {showLiveValues && tag && <span className="st-inline-chip">{formatInlineValue(tag, token)}</span>}
      </span>
    );
  }
  return <span key={key}>{token}</span>;
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

function formatInlineValue(tag: TagDefinition, ref: string): string {
  const value = formatTagValue(tag, ref);
  if (value === "true") return "1";
  if (value === "false") return "0";
  return value;
}

function getStructuredTextKeywords(): Set<string> {
  return new Set([
    ...getStructuredTextControlKeywords(),
    ...getStructuredTextOperatorKeywords(),
    ...getStructuredTextFunctionNames(),
    "TRUE", "FALSE",
  ]);
}

function getStructuredTextControlKeywords(): Set<string> {
  return new Set([
    "IF", "THEN", "ELSE", "END_IF",
    "ELSIF",
    "CASE", "OF", "END_CASE",
    "FOR", "TO", "BY", "DO", "END_FOR",
    "WHILE", "END_WHILE",
  ]);
}

function getStructuredTextOperatorKeywords(): Set<string> {
  return new Set([
    "AND", "OR", "NOT", "MOD",
  ]);
}

function getStructuredTextFunctionNames(): Set<string> {
  return new Set([
    "ABS", "SQR", "SQRT", "MIN", "MAX", "LIMIT",
    "BAND", "BOR", "BXOR", "BNOT", "SHL", "SHR",
    "TON", "TOF", "RTO", "TONR", "RES",
  ]);
}
