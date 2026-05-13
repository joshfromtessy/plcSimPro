import { useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { useSimulationStore } from "../../store/simulationStore";
import { useProjectStore } from "../../store/projectStore";
import { useAuthStore } from "../../store/authStore";
import type { PlcProject } from "../../model/types";
import { CloudProjectMenu } from "./CloudProjectMenu";
import { AccountMenu } from "./AccountMenu";
import { FileMenu } from "./FileMenu";
import "./Toolbar.css";

interface ToolbarProps {
  theme: "dark" | "light";
  onToggleTheme: () => void;
}

export function Toolbar({ theme, onToggleTheme }: ToolbarProps) {
  const { mode, start, stop, singleScan, scanIntervalMs, setScanInterval } = useSimulationStore();
  const { user } = useAuthStore();
  const {
    project,
    setProjectName,
    newProject,
    loadProject,
    setOnlineEditActive,
    acceptOnlineEdits,
    cancelOnlineEdits,
  } = useProjectStore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [nameDraft, setNameDraft] = useState(project.name);
  const hasOnlineEdits = project.programs.some((program) =>
    program.routines.some((routine) =>
      routine.rungs.some((rung) => rung.onlineEditStatus)
    )
  );

  useEffect(() => {
    setNameDraft(project.name);
  }, [project.name]);

  function commitProjectName() {
    const next = nameDraft.trim() || "Untitled Project";
    if (next !== project.name) setProjectName(next);
    else setNameDraft(project.name);
  }

  function handleBranchDragStart(e: React.DragEvent) {
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData("application/plc-branch-wrap", "branch");
  }

  function handleAddLegDragStart(e: React.DragEvent) {
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData("application/plc-add-leg", "leg");
  }

  function handleSave() {
    const json = JSON.stringify(project, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${project.name.replace(/[^a-z0-9_\-]/gi, "_")}.plcsim`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleLoad() {
    fileInputRef.current?.click();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = JSON.parse(evt.target?.result as string) as PlcProject;
        loadProject(data);
      } catch {
        // Silently swallow parse errors — user will notice nothing loaded
      }
    };
    reader.readAsText(file);
    // Reset so the same file can be reloaded if needed
    e.target.value = "";
  }

  function handleNew() {
    if (window.confirm("Start a new project? Unsaved changes will be lost.")) {
      newProject();
    }
  }

  function handleRunToggle() {
    if (mode === "running") {
      stop();
      setOnlineEditActive(false);
    } else {
      start();
      setOnlineEditActive(true);
    }
  }

  function handleAcceptEdits() {
    acceptOnlineEdits();
  }

  function handleCancelEdits() {
    if (!window.confirm("Cancel all pending online edits?")) return;
    cancelOnlineEdits();
  }

  return (
    <div className="toolbar">
      {/* Left: brand + project name + file ops */}
      <div className="toolbar-left">
        <span className="toolbar-brand">PLC Sim</span>
        <span className="toolbar-divider" />
        <input
          className="toolbar-project-name-input"
          value={nameDraft}
          aria-label="Project name"
          title="Rename project"
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={commitProjectName}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setNameDraft(project.name);
              e.currentTarget.blur();
            }
          }}
        />
        <span className="toolbar-divider" />
        <FileMenu onNew={handleNew} onSave={handleSave} onOpen={handleLoad} />
        {user && <CloudProjectMenu />}
        {/* Hidden file input for open dialog */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".plcsim,.json"
          style={{ display: "none" }}
          onChange={handleFileChange}
        />
      </div>

      {/* Center: sim controls */}
      <div className="toolbar-center">
        <button
          className={`toolbar-btn sim-btn ${mode === "running" ? "active" : ""}`}
          onClick={handleRunToggle}
          title={mode === "running" ? "Stop (F5)" : "Run (F5)"}
        >
          {mode === "running" ? (
            <SimStopIcon />
          ) : (
            <SimRunIcon />
          )}
          <span>{mode === "running" ? "Stop" : "Run"}</span>
        </button>

        <button
          className="toolbar-btn sim-btn"
          onClick={singleScan}
          disabled={mode === "running"}
          title="Single Scan (F6)"
        >
          <SimStepIcon />
          <span>Single Scan</span>
        </button>

        <div className="toolbar-sim-status">
          <span className={`sim-mode-badge ${mode}`}>{mode}</span>
          <label className="task-period-control" title="Periodic task period">
            <span>Task</span>
            <input
              type="number"
              min={10}
              max={5000}
              step={10}
              value={scanIntervalMs}
              onChange={e => setScanInterval(Number(e.target.value))}
            />
            <span>ms</span>
          </label>
        </div>

        {hasOnlineEdits && (
          <div className="online-edit-controls">
            <button className="toolbar-btn online-edit-accept" onClick={handleAcceptEdits}>
              Accept Edits
            </button>
            <button className="toolbar-btn online-edit-cancel" onClick={handleCancelEdits}>
              Cancel Edits
            </button>
          </div>
        )}
      </div>

      <div className="toolbar-tools">
        <button
          className="toolbar-btn tool-drag-btn"
          draggable
          onDragStart={handleBranchDragStart}
          title="Drag onto an instruction to wrap it in a branch"
        >
          <BranchIcon />
          <span>Branch</span>
        </button>
        <button
          className="toolbar-btn tool-drag-btn"
          draggable
          onDragStart={handleAddLegDragStart}
          title="Drag onto a branch to add a parallel leg"
        >
          <AddLegIcon />
          <span>Add Leg</span>
        </button>
      </div>

      {/* Right: theme toggle */}
      <div className="toolbar-right">
        <nav className="toolbar-nav" aria-label="Site">
          <NavLink to="/" end>Editor</NavLink>
          <NavLink to="/community">Community</NavLink>
          <NavLink to="/help">Help</NavLink>
          <NavLink to="/about">About</NavLink>
        </nav>
        <AccountMenu />
        <button className="toolbar-btn icon-btn" onClick={onToggleTheme} title="Toggle theme">
          {theme === "dark" ? "Light" : "Dark"}
        </button>
      </div>
    </div>
  );
}

function BranchIcon() {
  return (
    <svg width="15" height="14" viewBox="0 0 15 14" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 7h2.5" />
      <path d="M10.5 7H13" />
      <path d="M4.5 3h6v8h-6z" />
      <path d="M4.5 3v8" />
      <path d="M10.5 3v8" />
    </svg>
  );
}

function AddLegIcon() {
  return (
    <svg width="15" height="14" viewBox="0 0 15 14" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 4h9" />
      <path d="M2 10h9" />
      <path d="M2 4v6" />
      <path d="M11 4v6" />
      <path d="M13 5.5v4" />
      <path d="M11 7.5h4" />
    </svg>
  );
}

function SimRunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      <polygon points="2,1 13,7 2,13" />
    </svg>
  );
}

function SimStopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      <rect x="2" y="2" width="10" height="10" rx="1" />
    </svg>
  );
}

function SimStepIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      <polygon points="1,1 8,7 1,13" />
      <rect x="10" y="1" width="3" height="12" rx="1" />
    </svg>
  );
}
