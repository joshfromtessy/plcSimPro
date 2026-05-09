import { useState } from "react";
import { useProjectStore } from "../../store/projectStore";
import { TagPanel } from "./TagPanel";
import type { RoutineLanguage } from "../../model/types";
import "./WorkspacePanel.css";

type WorkspaceTab = "programs" | "tags";

export function WorkspacePanel() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("programs");

  return (
    <aside className="workspace-panel">
      <div className="workspace-tabs">
        <button
          className={`workspace-tab${activeTab === "programs" ? " workspace-tab--active" : ""}`}
          type="button"
          onClick={() => setActiveTab("programs")}
        >
          Programs
        </button>
        <button
          className={`workspace-tab${activeTab === "tags" ? " workspace-tab--active" : ""}`}
          type="button"
          onClick={() => setActiveTab("tags")}
        >
          Tags
        </button>
      </div>

      <div className="workspace-content">
        {activeTab === "programs" ? <ProgramTree /> : <TagPanel embedded />}
      </div>
    </aside>
  );
}

function ProgramTree() {
  const {
    project,
    activeRoutineId,
    setActiveRoutine,
    addRoutine,
    renameRoutine,
    deleteRoutine,
  } = useProjectStore();
  const [openPrograms, setOpenPrograms] = useState<Set<string>>(
    () => new Set(project.programs.map(program => program.id))
  );
  const [editingRoutineId, setEditingRoutineId] = useState<string | null>(null);
  const [editingRoutineName, setEditingRoutineName] = useState("");

  function toggleProgram(programId: string) {
    setOpenPrograms(current => {
      const next = new Set(current);
      if (next.has(programId)) next.delete(programId);
      else next.add(programId);
      return next;
    });
  }

  function handleAddRoutine(programId: string, existingCount: number, language: RoutineLanguage) {
    addRoutine(programId, `${language === "ST" ? "StructuredText" : "Routine"}${existingCount + 1}`, language);
    setOpenPrograms(current => new Set(current).add(programId));
  }

  function startRenameRoutine(routineId: string, currentName: string) {
    setEditingRoutineId(routineId);
    setEditingRoutineName(currentName);
  }

  function commitRenameRoutine() {
    if (!editingRoutineId) return;
    renameRoutine(editingRoutineId, editingRoutineName);
    setEditingRoutineId(null);
    setEditingRoutineName("");
  }

  function cancelRenameRoutine() {
    setEditingRoutineId(null);
    setEditingRoutineName("");
  }

  function handleDeleteRoutine(routineId: string, routineName: string) {
    if (window.confirm(`Delete routine "${routineName}"?`)) {
      deleteRoutine(routineId);
    }
  }

  return (
    <div className="program-tree">
      <div className="program-tree-header">
        <div className="program-tree-title">{project.name}</div>
        <div className="program-tree-subtitle">Controller Organizer</div>
      </div>

      <div className="program-tree-list">
        {project.programs.map(program => {
          const isOpen = openPrograms.has(program.id);

          return (
            <div key={program.id} className="program-node">
              <div className="program-row">
                <button
                  className={`program-expand${isOpen ? " program-expand--open" : ""}`}
                  type="button"
                  onClick={() => toggleProgram(program.id)}
                  title={isOpen ? "Collapse program" : "Expand program"}
                />
                <button
                  className="program-name"
                  type="button"
                  onClick={() => toggleProgram(program.id)}
                >
                  {program.name}
                </button>
                <div className="routine-add-group">
                  <button
                    className="routine-add-btn"
                    type="button"
                    onClick={() => handleAddRoutine(program.id, program.routines.length, "LAD")}
                    title="Add ladder routine"
                  >
                    +L
                  </button>
                  <button
                    className="routine-add-btn routine-add-btn--st"
                    type="button"
                    onClick={() => handleAddRoutine(program.id, program.routines.length, "ST")}
                    title="Add structured text routine"
                  >
                    +S
                  </button>
                </div>
              </div>

              {isOpen && (
                <div className="routine-list">
                  {program.routines.map(routine => {
                    const isEditing = editingRoutineId === routine.id;

                    return (
                      <div
                        key={routine.id}
                        className={`routine-row${routine.id === activeRoutineId ? " routine-row--active" : ""}`}
                        onClick={() => {
                          if (!isEditing) setActiveRoutine(routine.id);
                        }}
                      >
                        <span className={`routine-icon routine-icon--${(routine.language ?? "LAD").toLowerCase()}`}>
                          {routine.language ?? "LAD"}
                        </span>
                        {isEditing ? (
                          <input
                            className="routine-name-input"
                            value={editingRoutineName}
                            autoFocus
                            onChange={e => setEditingRoutineName(e.target.value)}
                            onBlur={commitRenameRoutine}
                            onClick={e => e.stopPropagation()}
                            onKeyDown={e => {
                              if (e.key === "Enter") commitRenameRoutine();
                              if (e.key === "Escape") cancelRenameRoutine();
                            }}
                          />
                        ) : (
                          <button
                            className="routine-name"
                            type="button"
                            onDoubleClick={e => {
                              e.stopPropagation();
                              startRenameRoutine(routine.id, routine.name);
                            }}
                          >
                            {routine.name}
                          </button>
                        )}
                        <span className="routine-count">
                          {(routine.language ?? "LAD") === "ST" ? `${(routine.structuredText ?? "").split(/\r?\n/).length}L` : routine.rungs.length}
                        </span>
                        {!isEditing && (
                          <div className="routine-actions">
                            <button
                              className="routine-action-btn"
                              type="button"
                              title="Rename routine"
                              onClick={e => {
                                e.stopPropagation();
                                startRenameRoutine(routine.id, routine.name);
                              }}
                            >
                              Ren
                            </button>
                            <button
                              className="routine-action-btn routine-action-btn--danger"
                              type="button"
                              title="Delete routine"
                              onClick={e => {
                                e.stopPropagation();
                                handleDeleteRoutine(routine.id, routine.name);
                              }}
                            >
                              Del
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
