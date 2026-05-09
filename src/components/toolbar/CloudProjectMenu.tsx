import { useEffect, useRef, useState } from "react";
import { useCloudProjectStore } from "../../store/cloudProjectStore";
import { useProjectStore } from "../../store/projectStore";

export function CloudProjectMenu() {
  const project = useProjectStore((s) => s.project);
  const loadProject = useProjectStore((s) => s.loadProject);
  const {
    projects,
    loading,
    error,
    lastSavedAt,
    refreshProjects,
    saveCurrentProject,
    loadProjectById,
    clearError,
  } = useCloudProjectStore();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void refreshProjects();
  }, [open, refreshProjects]);

  useEffect(() => {
    function handlePointerDown(e: PointerEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  async function handleSave() {
    await saveCurrentProject(project);
  }

  async function handleLoad(id: string) {
    const cloudProject = await loadProjectById(id);
    if (!cloudProject) return;
    loadProject(cloudProject);
    setOpen(false);
  }

  return (
    <div className="cloud-project-menu" ref={menuRef}>
      <button className="toolbar-btn" onClick={handleSave} disabled={loading}>
        Cloud Save
      </button>
      <button className="toolbar-btn" onClick={() => setOpen((value) => !value)}>
        Cloud Open
      </button>
      {open && (
        <div className="cloud-project-popover">
          <div className="cloud-project-popover-head">
            <span>Cloud Projects</span>
            <button onClick={() => void refreshProjects()} disabled={loading}>
              Refresh
            </button>
          </div>
          {error && (
            <button className="cloud-project-error" onClick={clearError}>
              {error}
            </button>
          )}
          {lastSavedAt && (
            <div className="cloud-project-meta">
              Saved {new Date(lastSavedAt).toLocaleString()}
            </div>
          )}
          {loading && <div className="cloud-project-empty">Working...</div>}
          {!loading && projects.length === 0 && (
            <div className="cloud-project-empty">No cloud projects yet.</div>
          )}
          {!loading && projects.map((item) => (
            <button
              key={item.id}
              className="cloud-project-row"
              onClick={() => void handleLoad(item.id)}
            >
              <span>{item.name}</span>
              <em>{new Date(item.updated_at).toLocaleString()}</em>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
