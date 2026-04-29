// =============================================================================
// Tag Panel — tag database + properties panel
// =============================================================================
import { useState, useRef, useEffect } from "react";
import { useProjectStore } from "../../store/projectStore";
import type { TagDefinition, TagDataType } from "../../model/types";
import "./TagPanel.css";

export function TagPanel() {
  const { project, addTag, deleteTag, setTagValue } = useProjectStore();
  const [newName, setNewName]   = useState("");
  const [newType, setNewType]   = useState<TagDataType>("BOOL");
  const [newSize, setNewSize]   = useState("1");
  const [error, setError]       = useState("");

  const showSizeField = newType === "DINT" || newType === "INT";

  function handleAddTag() {
    const name = newName.trim();
    if (!name) { setError("Name required"); return; }
    if (project.tags.find(t => t.name === name)) { setError("Name already exists"); return; }

    let size: number | undefined;
    if (showSizeField) {
      const parsed = parseInt(newSize, 10);
      if (isNaN(parsed) || parsed < 1 || parsed > 256) {
        setError("Size must be 1–256");
        return;
      }
      size = parsed > 1 ? parsed : undefined;
    }

    addTag(name, newType, undefined, size);
    setNewName("");
    setNewSize("1");
    setError("");
  }

  return (
    <div className="tag-panel">
      <div className="tag-panel-header">Tag Database</div>

      {/* Add tag form */}
      <div className="tag-add-form">
        <input
          className="tag-input"
          placeholder="Tag name"
          value={newName}
          onChange={e => { setNewName(e.target.value); setError(""); }}
          onKeyDown={e => e.key === "Enter" && handleAddTag()}
        />
        <select
          className="tag-select"
          value={newType}
          onChange={e => { setNewType(e.target.value as TagDataType); setError(""); }}
        >
          <option value="BOOL">BOOL</option>
          <option value="DINT">DINT</option>
          <option value="INT">INT</option>
          <option value="REAL">REAL</option>
          <option value="TIMER">TIMER</option>
          <option value="COUNTER">COUNTER</option>
        </select>
        {showSizeField && (
          <input
            className="tag-size-input"
            type="number"
            min={1}
            max={256}
            placeholder="Size"
            title="Array size (1 = scalar)"
            value={newSize}
            onChange={e => { setNewSize(e.target.value); setError(""); }}
            onKeyDown={e => e.key === "Enter" && handleAddTag()}
          />
        )}
        <button className="tag-add-btn" onClick={handleAddTag}>+</button>
        {error && <div className="tag-error">{error}</div>}
      </div>

      {/* Tag list */}
      <div className="tag-list">
        {project.tags.length === 0 && (
          <div className="tag-empty">No tags defined</div>
        )}
        {project.tags.map(tag => (
          <TagRow
            key={tag.id}
            tag={tag}
            onToggle={() => {
              if (tag.dataType === "BOOL") {
                setTagValue(tag.name, !(tag.value as boolean));
              }
            }}
            onDelete={() => deleteTag(tag.id)}
          />
        ))}
      </div>
    </div>
  );
}

const NUMERIC_TYPES = new Set<TagDataType>(["DINT", "INT", "REAL"]);

function TagRow({
  tag, onToggle, onDelete,
}: {
  tag: TagDefinition;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const { setTagValue, setTagElementValue, setTagBit, setTagDescription } = useProjectStore();
  const [expanded, setExpanded] = useState(false);

  const isArray      = Array.isArray(tag.value);
  const isWordType   = tag.dataType === "DINT" || tag.dataType === "INT";
  const isExpandable = isWordType; // DINT/INT always expandable (array elements or scalar bits)
  const isNumeric    = NUMERIC_TYPES.has(tag.dataType);

  // ── Scalar numeric value editing ──────────────────────────────────────────
  const [editing, setEditing]   = useState(false);
  const [editVal, setEditVal]   = useState("");
  const numInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) numInputRef.current?.select();
  }, [editing]);

  function startEdit() {
    setEditVal(String(tag.value));
    setEditing(true);
  }

  function commitEdit() {
    const num = tag.dataType === "REAL"
      ? parseFloat(editVal)
      : parseInt(editVal, 10);
    if (!isNaN(num)) setTagValue(tag.name, num);
    setEditing(false);
  }

  function handleNumKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter")  { e.preventDefault(); commitEdit(); }
    if (e.key === "Escape") { setEditing(false); }
  }

  // ── Description (comment) editing ─────────────────────────────────────────
  const [editingDesc, setEditingDesc] = useState(false);
  const [descVal, setDescVal]         = useState("");
  const descInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingDesc) {
      descInputRef.current?.focus();
      descInputRef.current?.select();
    }
  }, [editingDesc]);

  function startEditDesc() {
    setDescVal(tag.description ?? "");
    setEditingDesc(true);
  }

  function commitDesc() {
    setTagDescription(tag.id, descVal.trim());
    setEditingDesc(false);
  }

  function handleDescKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter")  { e.preventDefault(); commitDesc(); }
    if (e.key === "Escape") { setEditingDesc(false); }
  }

  const hasDesc = !!tag.description;

  return (
    <div className={`tag-row ${tag.dataType === "BOOL" && tag.value ? "tag-row--true" : ""}`}>
      {/* ── Main row: name · type · value · delete ── */}
      <div className="tag-row-main">
        {/* Expand toggle for DINT/INT tags (array or scalar) */}
        {isExpandable ? (
          <button
            className={`tag-expand-btn${expanded ? " tag-expand-btn--open" : ""}`}
            onClick={() => setExpanded(x => !x)}
            title={expanded ? "Collapse" : "Expand"}
          />
        ) : (
          <span className="tag-expand-spacer" />
        )}
        <div className="tag-row-name">
          {tag.name}
          {isArray && (
            <span className="tag-array-badge">
              [{(tag.value as number[]).length}]
            </span>
          )}
        </div>
        <div className="tag-row-type">{tag.dataType}</div>
        <div className="tag-row-value">
          {tag.dataType === "BOOL" ? (
            <button
              className={`tag-bool-toggle ${tag.value ? "tag-bool-toggle--on" : ""}`}
              onClick={onToggle}
              title="Click to toggle"
            >
              {tag.value ? "TRUE" : "FALSE"}
            </button>
          ) : tag.dataType === "TIMER" && tag.timerData ? (
            <span className="tag-structured">
              EN:{tag.timerData.en ? "1" : "0"}
              {" "}TT:{tag.timerData.tt ? "1" : "0"}
              {" "}DN:{tag.timerData.dn ? "1" : "0"}
              {" "}ACC:{tag.timerData.accum}
            </span>
          ) : tag.dataType === "COUNTER" && tag.counterData ? (
            <span className="tag-structured">
              DN:{tag.counterData.dn ? "1" : "0"}
              {" "}ACC:{tag.counterData.accum}
            </span>
          ) : isNumeric && !isArray ? (
            editing ? (
              <input
                ref={numInputRef}
                className="tag-num-input"
                type="number"
                value={editVal}
                onChange={e => setEditVal(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={handleNumKeyDown}
              />
            ) : (
              <span
                className="tag-num tag-num--editable"
                onClick={startEdit}
                title="Click to edit"
              >
                {String(tag.value)}
              </span>
            )
          ) : isArray ? (
            <span className="tag-array-summary">
              {(tag.value as number[]).slice(0, 4).join(", ")}
              {(tag.value as number[]).length > 4 ? "…" : ""}
            </span>
          ) : (
            <span className="tag-num">{String(tag.value)}</span>
          )}
        </div>
        <button className="tag-delete-btn" onClick={onDelete} title="Delete tag">✕</button>
      </div>

      {/* ── Expanded content: array elements OR scalar bits ── */}
      {isExpandable && expanded && (
        <div className="tag-array-elements">
          {isArray
            ? (tag.value as number[]).map((val, i) => (
                <ArrayElementRow
                  key={i}
                  tag={tag}
                  idx={i}
                  value={val}
                  onCommit={v => setTagElementValue(tag.name, i, v)}
                />
              ))
            : <ScalarBitRows tag={tag} value={tag.value as number} onToggle={(b, v) => setTagBit(tag.name, undefined, b, v)} />
          }
        </div>
      )}

      {/* ── Description row ── */}
      {editingDesc ? (
        <div className="tag-desc-row">
          <input
            ref={descInputRef}
            className="tag-desc-input"
            placeholder="Add comment…"
            value={descVal}
            onChange={e => setDescVal(e.target.value)}
            onBlur={commitDesc}
            onKeyDown={handleDescKeyDown}
          />
        </div>
      ) : (
        <div
          className={`tag-desc-row ${hasDesc ? "tag-desc-row--has-desc" : "tag-desc-row--empty"}`}
          onClick={startEditDesc}
          title="Click to edit comment"
        >
          {hasDesc ? tag.description : ""}
        </div>
      )}
    </div>
  );
}

/** Renders the 32 (or 16) bit rows for a scalar DINT/INT tag. */
function ScalarBitRows({
  tag, value, onToggle,
}: {
  tag: TagDefinition;
  value: number;
  onToggle: (bit: number, val: boolean) => void;
}) {
  const maxBit = tag.dataType === "DINT" ? 31 : 15;
  return (
    <div className="tag-bit-rows">
      {Array.from({ length: maxBit + 1 }, (_, b) => {
        const bitVal = ((value >> b) & 1) === 1;
        return (
          <div key={b} className="tag-bit-row">
            <span className="tag-bit-name">{tag.name}.{b}</span>
            <span className="tag-bit-type">BOOL</span>
            <button
              className={`tag-bool-toggle tag-bool-toggle--sm ${bitVal ? "tag-bool-toggle--on" : ""}`}
              onClick={() => onToggle(b, !bitVal)}
            >
              {bitVal ? "1" : "0"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Editable row for a single element of a DINT/INT array, with bit drill-down. */
function ArrayElementRow({
  tag, idx, value, onCommit,
}: {
  tag: TagDefinition;
  idx: number;
  value: number;
  onCommit: (v: number) => void;
}) {
  const { setTagBit } = useProjectStore();
  const [editing, setEditing]   = useState(false);
  const [editVal, setEditVal]   = useState("");
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const maxBit = tag.dataType === "DINT" ? 31 : 15;

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  function startEdit() { setEditVal(String(value)); setEditing(true); }
  function commit() {
    const n = parseInt(editVal, 10);
    if (!isNaN(n)) onCommit(n);
    setEditing(false);
  }
  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter")  { e.preventDefault(); commit(); }
    if (e.key === "Escape") { setEditing(false); }
  }

  const bits = Array.from({ length: maxBit + 1 }, (_, b) => ((value >> b) & 1) === 1);

  return (
    <>
      <div className="tag-element-row">
        <button
          className="tag-expand-btn"
          onClick={() => setExpanded(x => !x)}
          title={expanded ? "Collapse bits" : "Expand bits"}
        >
          {expanded ? "▾" : "▸"}
        </button>
        <span className="tag-element-name">{tag.name}[{idx}]</span>
        {editing ? (
          <input
            ref={inputRef}
            className="tag-num-input"
            type="number"
            value={editVal}
            onChange={e => setEditVal(e.target.value)}
            onBlur={commit}
            onKeyDown={handleKey}
          />
        ) : (
          <span
            className="tag-num tag-num--editable"
            onClick={startEdit}
            title="Click to edit word value"
          >
            {value}
          </span>
        )}
        <span className="tag-element-hex">0x{(value >>> 0).toString(16).toUpperCase().padStart(8, "0")}</span>
      </div>
      {expanded && (
        <div className="tag-bit-rows">
          {bits.map((bitVal, b) => (
            <div key={b} className="tag-bit-row">
              <span className="tag-bit-name">{tag.name}[{idx}].{b}</span>
              <span className="tag-bit-type">BOOL</span>
              <button
                className={`tag-bool-toggle tag-bool-toggle--sm ${bitVal ? "tag-bool-toggle--on" : ""}`}
                onClick={() => setTagBit(tag.name, idx, b, !bitVal)}
                title="Click to toggle"
              >
                {bitVal ? "1" : "0"}
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
