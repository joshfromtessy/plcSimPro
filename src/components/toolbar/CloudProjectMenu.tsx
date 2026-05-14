import { useEffect, useRef, useState } from "react";
import {
  listMyCommunityProjects,
  parseTagInput,
  publishCommunityProject,
  unpublishCommunityProject,
  updateCommunityProjectMetadata,
  type CommunityDifficulty,
  type CommunityProjectSummary,
} from "../../lib/communityProjects";
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
  const [communityProjects, setCommunityProjects] = useState<CommunityProjectSummary[]>([]);
  const [communityLoading, setCommunityLoading] = useState(false);
  const [communityError, setCommunityError] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishTitle, setPublishTitle] = useState(project.name);
  const [publishDescription, setPublishDescription] = useState("");
  const [publishAuthor, setPublishAuthor] = useState("");
  const [publishTags, setPublishTags] = useState("");
  const [publishDifficulty, setPublishDifficulty] = useState<CommunityDifficulty>("beginner");
  const [publishRecipeNotes, setPublishRecipeNotes] = useState("");
  const [editingCommunityId, setEditingCommunityId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editAuthor, setEditAuthor] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editDifficulty, setEditDifficulty] = useState<CommunityDifficulty>("beginner");
  const [editRecipeNotes, setEditRecipeNotes] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void refreshProjects();
    void refreshCommunityProjects();
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

  function handlePublishToggle() {
    if (!publishOpen) setPublishTitle(project.name);
    setPublishOpen(value => !value);
  }

  async function refreshCommunityProjects() {
    setCommunityLoading(true);
    setCommunityError(null);
    try {
      const items = await listMyCommunityProjects();
      setCommunityProjects(items);
    } catch (err) {
      setCommunityError(getErrorMessage(err));
    } finally {
      setCommunityLoading(false);
    }
  }

  async function handlePublish() {
    setCommunityLoading(true);
    setCommunityError(null);
    try {
      await publishCommunityProject(project, {
        title: publishTitle,
        description: publishDescription,
        authorDisplayName: publishAuthor,
        tags: parseTagInput(publishTags),
        difficulty: publishDifficulty,
        recipeNotes: publishRecipeNotes,
      });
      setPublishOpen(false);
      await refreshCommunityProjects();
    } catch (err) {
      setCommunityError(getErrorMessage(err));
      setCommunityLoading(false);
    }
  }

  function beginEditCommunityProject(item: CommunityProjectSummary) {
    setEditingCommunityId(item.id);
    setEditTitle(item.title);
    setEditDescription(item.description);
    setEditAuthor(item.author_display_name);
    setEditTags(item.tags.join(", "));
    setEditDifficulty(item.difficulty);
    setEditRecipeNotes(item.recipe_notes);
  }

  async function handleUpdateCommunityProject() {
    if (!editingCommunityId) return;
    setCommunityLoading(true);
    setCommunityError(null);
    try {
      await updateCommunityProjectMetadata(editingCommunityId, {
        title: editTitle,
        description: editDescription,
        authorDisplayName: editAuthor,
        tags: parseTagInput(editTags),
        difficulty: editDifficulty,
        recipeNotes: editRecipeNotes,
      });
      setEditingCommunityId(null);
      await refreshCommunityProjects();
    } catch (err) {
      setCommunityError(getErrorMessage(err));
      setCommunityLoading(false);
    }
  }

  async function handleUnpublish(id: string, title: string) {
    if (!window.confirm(`Unpublish "${title}" from Community?`)) return;
    setCommunityLoading(true);
    setCommunityError(null);
    try {
      await unpublishCommunityProject(id);
      await refreshCommunityProjects();
    } catch (err) {
      setCommunityError(getErrorMessage(err));
      setCommunityLoading(false);
    }
  }

  return (
    <div className="toolbar-menu" ref={menuRef}>
      <button className="toolbar-btn" onClick={() => setOpen((value) => !value)}>
        Cloud
      </button>
      {open && (
        <div className="toolbar-popover cloud-project-popover">
          <div className="cloud-project-popover-head">
            <span>Cloud Projects</span>
            <button onClick={() => void refreshProjects()} disabled={loading}>
              Refresh
            </button>
          </div>
          <button className="toolbar-menu-row primary" onClick={handleSave} disabled={loading}>
            Save current project
          </button>
          <button
            className="toolbar-menu-row primary community-publish-toggle"
            onClick={handlePublishToggle}
            disabled={communityLoading}
          >
            Publish to Community
          </button>
          {publishOpen && (
            <div className="community-publish-form">
              <label>
                <span>Title</span>
                <input value={publishTitle} onChange={event => setPublishTitle(event.target.value)} />
              </label>
              <label>
                <span>Description</span>
                <textarea
                  rows={3}
                  value={publishDescription}
                  onChange={event => setPublishDescription(event.target.value)}
                />
              </label>
              <label>
                <span>Author</span>
                <input
                  value={publishAuthor}
                  placeholder="Display name"
                  onChange={event => setPublishAuthor(event.target.value)}
                />
              </label>
              <label>
                <span>Tags</span>
                <input
                  value={publishTags}
                  placeholder="timer, sequencing"
                  onChange={event => setPublishTags(event.target.value)}
                />
              </label>
              <label>
                <span>Difficulty</span>
                <select
                  value={publishDifficulty}
                  onChange={event => setPublishDifficulty(event.target.value as "beginner" | "intermediate" | "advanced")}
                >
                  <option value="beginner">Beginner</option>
                  <option value="intermediate">Intermediate</option>
                  <option value="advanced">Advanced</option>
                </select>
              </label>
              <label>
                <span>Recipe notes</span>
                <textarea
                  rows={4}
                  value={publishRecipeNotes}
                  placeholder="What this teaches, how to run it, or what to try first."
                  onChange={event => setPublishRecipeNotes(event.target.value)}
                />
              </label>
              <button className="toolbar-menu-row primary" onClick={() => void handlePublish()} disabled={communityLoading}>
                Publish now
              </button>
            </div>
          )}
          {error && (
            <button className="cloud-project-error" onClick={clearError}>
              {error}
            </button>
          )}
          {communityError && (
            <button className="cloud-project-error" onClick={() => setCommunityError(null)}>
              {communityError}
            </button>
          )}
          {lastSavedAt && (
            <div className="cloud-project-meta">
              Saved {new Date(lastSavedAt).toLocaleString()}
            </div>
          )}
          <div className="cloud-project-section-label">Open saved project</div>
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
          <div className="cloud-project-section-label">Published to community</div>
          {communityLoading && <div className="cloud-project-empty">Working...</div>}
          {!communityLoading && communityProjects.length === 0 && (
            <div className="cloud-project-empty">No published projects yet.</div>
          )}
          {!communityLoading && communityProjects.map((item) => (
            <div className="cloud-project-row community-project-row" key={item.id}>
              <span>{item.title}</span>
              <em>{item.difficulty} - Updated {new Date(item.updated_at).toLocaleString()}</em>
              {editingCommunityId === item.id ? (
                <div className="community-publish-form community-edit-form">
                  <label>
                    <span>Title</span>
                    <input value={editTitle} onChange={event => setEditTitle(event.target.value)} />
                  </label>
                  <label>
                    <span>Description</span>
                    <textarea rows={3} value={editDescription} onChange={event => setEditDescription(event.target.value)} />
                  </label>
                  <label>
                    <span>Author</span>
                    <input value={editAuthor} onChange={event => setEditAuthor(event.target.value)} />
                  </label>
                  <label>
                    <span>Tags</span>
                    <input value={editTags} onChange={event => setEditTags(event.target.value)} />
                  </label>
                  <label>
                    <span>Difficulty</span>
                    <select
                      value={editDifficulty}
                      onChange={event => setEditDifficulty(event.target.value as CommunityDifficulty)}
                    >
                      <option value="beginner">Beginner</option>
                      <option value="intermediate">Intermediate</option>
                      <option value="advanced">Advanced</option>
                    </select>
                  </label>
                  <label>
                    <span>Recipe notes</span>
                    <textarea rows={4} value={editRecipeNotes} onChange={event => setEditRecipeNotes(event.target.value)} />
                  </label>
                  <div className="community-row-actions">
                    <button className="community-save-edit-btn" type="button" onClick={() => void handleUpdateCommunityProject()} disabled={communityLoading}>
                      Save metadata
                    </button>
                    <button className="community-secondary-action-btn" type="button" onClick={() => setEditingCommunityId(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="community-row-actions">
                  <button
                    className="community-secondary-action-btn"
                    type="button"
                    onClick={() => beginEditCommunityProject(item)}
                  >
                    Edit
                  </button>
                  <button
                    className="community-unpublish-btn"
                    type="button"
                    onClick={() => void handleUnpublish(item.id, item.title)}
                  >
                    Unpublish
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Community project operation failed.";
}
