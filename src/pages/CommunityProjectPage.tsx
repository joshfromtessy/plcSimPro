import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { PageShell } from "../components/PageShell";
import {
  cloneCommunityProject,
  incrementCloneCount,
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    void loadCommunityProject(id)
      .then(item => {
        if (!alive) return;
        setProject(item);
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

  if (!id) return <Navigate to="/community" replace />;

  async function handleClone() {
    if (!project) return;
    const ok = window.confirm(
      `Clone "${project.title}" into the editor? This will replace the currently open project "${currentProject.name}".`
    );
    if (!ok) return;

    loadProject(cloneCommunityProject(project.data));
    setCurrentProjectId(null);
    void incrementCloneCount(project.id);
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
              <h2>{project.title}</h2>
              <p>{project.description || "No description provided."}</p>
              <div className="community-tags">
                {project.tags.length === 0 ? <em>No tags</em> : project.tags.map(tag => <span key={tag}>{tag}</span>)}
              </div>
            </div>
            <dl className="community-preview-meta">
              <div><dt>Author</dt><dd>{project.author_display_name}</dd></div>
              <div><dt>Updated</dt><dd>{new Date(project.updated_at).toLocaleString()}</dd></div>
              <div><dt>Clones</dt><dd>{project.clone_count}</dd></div>
            </dl>
          </section>

          <section className="community-stats">
            <div><strong>{stats.programs}</strong><span>Programs</span></div>
            <div><strong>{stats.routines}</strong><span>Routines</span></div>
            <div><strong>{stats.ladderRungs}</strong><span>Rungs</span></div>
            <div><strong>{stats.tags}</strong><span>Tags</span></div>
          </section>

          <section className="page-card">
            <h2>Read-only project outline</h2>
            <div className="community-outline">
              {project.data.programs.map(program => (
                <div className="community-outline-program" key={program.id}>
                  <strong>{program.name}</strong>
                  {program.routines.map(routine => (
                    <div className="community-outline-routine" key={routine.id}>
                      <span>{routine.name}</span>
                      <em>{routine.language} - {routine.language === "ST" ? `${(routine.structuredText ?? "").split(/\r?\n/).length} lines` : `${routine.rungs.length} rungs`}</em>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </PageShell>
  );
}
