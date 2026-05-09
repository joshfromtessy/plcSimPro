import { useRef } from "react";
import { NavLink } from "react-router-dom";
import { useSimulationStore } from "../../store/simulationStore";
import { useProjectStore } from "../../store/projectStore";
import { useAuthStore } from "../../store/authStore";
import type { PlcProject } from "../../model/types";
import { CloudProjectMenu } from "./CloudProjectMenu";
import "./Toolbar.css";

interface ToolbarProps {
  theme: "dark" | "light";
  onToggleTheme: () => void;
}

export function Toolbar({ theme, onToggleTheme }: ToolbarProps) {
  const { mode, start, stop, singleScan, scanIntervalMs, setScanInterval } = useSimulationStore();
  const { user, signOut } = useAuthStore();
  const {
    project,
    newProject,
    loadProject,
    setOnlineEditActive,
    acceptOnlineEdits,
    cancelOnlineEdits,
  } = useProjectStore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasOnlineEdits = project.programs.some((program) =>
    program.routines.some((routine) =>
      routine.rungs.some((rung) => rung.onlineEditStatus)
    )
  );

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
        <span className="toolbar-project-name">{project.name}</span>
        <span className="toolbar-divider" />
        <button className="toolbar-btn" onClick={handleNew} title="New project">
          <NewIcon />
          <span>New</span>
        </button>
        <button className="toolbar-btn" onClick={handleSave} title="Save project as .plcsim">
          <SaveIcon />
          <span>Save</span>
        </button>
        <button className="toolbar-btn" onClick={handleLoad} title="Open .plcsim file">
          <LoadIcon />
          <span>Open</span>
        </button>
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
          <NavLink to="/help">Help</NavLink>
          <NavLink to="/about">About</NavLink>
          <NavLink to={user ? "/account" : "/login"}>
            {user ? "Account" : "Login"}
          </NavLink>
        </nav>
        {user && (
          <button className="toolbar-btn auth-chip" onClick={signOut} title={user.email ?? "Signed in"}>
            {user.email ?? "Account"}
          </button>
        )}
        <button className="toolbar-btn icon-btn" onClick={onToggleTheme} title="Toggle theme">
          {theme === "dark" ? "Light" : "Dark"}
        </button>
      </div>
    </div>
  );
}

function NewIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1.5" y="1.5" width="10" height="10" rx="1" />
      <path d="M6.5 4v5M4 6.5h5" />
    </svg>
  );
}

function SaveIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 2h7l2 2v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" />
      <rect x="3.5" y="7" width="6" height="4" rx="0.5" fill="currentColor" stroke="none" opacity="0.35" />
      <path d="M4.5 2v3h4V2" />
    </svg>
  );
}

function LoadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3l1.5 1.5H11A1.5 1.5 0 0 1 12.5 5v5A1.5 1.5 0 0 1 11 11.5H2A1.5 1.5 0 0 1 .5 10V3.5" />
      <path d="M6.5 5.5v4M4.5 7.5l2 2 2-2" />
    </svg>
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
