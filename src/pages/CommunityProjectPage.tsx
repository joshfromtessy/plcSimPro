import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { CommunityRoutinePreview } from "../components/community/CommunityRoutinePreview";
import { PageShell } from "../components/PageShell";
import {
  cloneCommunityProject,
  loadCommunityProject,
  type CommunityProjectDetail,
} from "../lib/communityProjects";
import { useCloudProjectStore } from "../store/cloudProjectStore";
import { useProjectStore } from "../store/projectStore";

interface CommunityProjectPageProps {
  theme: "dark" | "light";
}

export function CommunityProjectPage({ theme }: CommunityProjectPageProps) {
  const { id } = useParams();
  const navigate = useNavigate();
  const currentProject = useProjectStore((state) => state.project);
  const loadProject = useProjectStore((state) => state.loadProject);
  const setCurrentProjectId = useCloudProjectStore((state) => state.setCurrentProjectId);
  const [project, setProject] = useState<CommunityProjectDetail | null>(null);
  const [selectedRoutineId, setSelectedRoutineId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    void loadCommunityProject(id)
      .then(item => {
        if (!alive) return;
        setProject(item);
        setSelectedRoutineId(item.data.programs[0]?.routines[0]?.id ?? null);
        setLoading(false);
      })
      .catch(err => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : "Unable to load community project.");
        setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [id]);

  const stats = useMemo(() => {
    if (!project) return null;
    const routines = project.data.programs.flatMap(program => program.routines);
    return {
      programs: project.data.programs.length,
      routines: routines.length,
      ladderRungs: routines.reduce((sum, routine) => sum + routine.rungs.length, 0),
      tags: project.data.tags.length,
    };
  }, [project]);
  const selectedRoutine = useMemo(() => {
    if (!project || !selectedRoutineId) return null;
    return project.data.programs
      .flatMap(program => program.routines)
      .find(routine => routine.id === selectedRoutineId) ?? null;
  }, [project, selectedRoutineId]);

  if (!id) return <Navigate to="/community" replace />;

  async function handleClone() {
    if (!project) return;
    const ok = window.confirm(
      `Clone "${project.title}" into the editor? This will replace the currently open project "${currentProject.name}".`
    );
    if (!ok) return;

    loadProject(cloneCommunityProject(project.data));
    setCurrentProjectId(null);
    navigate("/");
  }

  return (
    <PageShell theme={theme} eyebrow="Community Preview" title={project?.title ?? "Community Project"} contentClassName="page-content--wide">
      <div className="community-preview-actions">
        <Link className="community-secondary-btn" to="/community">Back to Community</Link>
        <button className="auth-primary" onClick={() => void handleClone()} disabled={!project || loading}>
          Clone to editor
        </button>
      </div>

      {error && <div className="community-state community-state--error">{error}</div>}
      {loading && <div className="community-state">Loading project preview...</div>}

      {project && stats && (
        <>
          <section className="page-card page-card-large community-preview-hero">
            <div>
              <div className="community-card-badges community-preview-badges">
                {project.featured && <span className="community-featured-badge">Featured</span>}
                <span className={`community-difficulty-badge community-difficulty-badge--${project.difficulty}`}>
                  {project.difficulty}
                </span>
              </div>
              <h2>{project.title}</h2>
              <p>{project.description || "No description provided."}</p>
              <div className="community-tags">
                {project.tags.length === 0 ? <em>No tags</em> : project.tags.map(tag => <span key={tag}>{tag}</span>)}
              </div>
            </div>
            <dl className="community-preview-meta">
              <div><dt>Author</dt><dd>{project.author_display_name}</dd></div>
              <div><dt>Updated</dt><dd>{new Date(project.updated_at).toLocaleString()}</dd></div>
              <div><dt>Tags</dt><dd>{project.tags.length}</dd></div>
            </dl>
          </section>

          <section className="community-stats">
            <div><strong>{stats.programs}</strong><span>Programs</span></div>
            <div><strong>{stats.routines}</strong><span>Routines</span></div>
            <div><strong>{stats.ladderRungs}</strong><span>Rungs</span></div>
            <div><strong>{stats.tags}</strong><span>Tags</span></div>
          </section>

          {project.recipe_notes && (
            <section className="page-card community-recipe-card">
              <h2>Project Recipe</h2>
              <p>{project.recipe_notes}</p>
            </section>
          )}

          <section className="community-preview-workbench" aria-label="Read-only project preview">
            <aside className="page-card community-preview-sidebar">
              <h2>Routines</h2>
              <div className="community-outline">
                {project.data.programs.map(program => (
                  <div className="community-outline-program" key={program.id}>
                    <strong>{program.name}</strong>
                    {program.routines.map(routine => (
                      <button
                        className={`community-outline-routine ${routine.id === selectedRoutineId ? "community-outline-routine--active" : ""}`}
                        key={routine.id}
                        onClick={() => setSelectedRoutineId(routine.id)}
                        type="button"
                      >
                        <span>{routine.name}</span>
                        <em>{routine.language} - {routine.language === "ST" ? `${(routine.structuredText ?? "").split(/\r?\n/).length} lines` : `${routine.rungs.length} rungs`}</em>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </aside>

            <section className="page-card community-preview-pane">
              <div className="community-preview-pane-head">
                <div>
                  <h2>{selectedRoutine?.name ?? "No routine selected"}</h2>
                  {selectedRoutine && (
                    <span>{selectedRoutine.language === "ST" ? "Structured Text" : "Ladder Logic"} read-only preview</span>
                  )}
                </div>
                {selectedRoutine && <em>{selectedRoutine.language}</em>}
              </div>
              {selectedRoutine ? (
                <CommunityRoutinePreview routine={selectedRoutine} tags={project.data.tags} theme={theme} />
              ) : (
                <div className="community-state">This project does not contain any routines.</div>
              )}
            </section>
          </section>
        </>
      )}
    </PageShell>
  );
}
