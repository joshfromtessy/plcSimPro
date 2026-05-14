import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PageShell } from "../components/PageShell";
import {
  listCommunityProjects,
  parseTagInput,
  type CommunityProjectSummary,
} from "../lib/communityProjects";

interface CommunityPageProps {
  theme: "dark" | "light";
}

export function CommunityPage({ theme }: CommunityPageProps) {
  const [projects, setProjects] = useState<CommunityProjectSummary[]>([]);
  const [search, setSearch] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const tags = useMemo(() => parseTagInput(tagInput), [tagInput]);

  useEffect(() => {
    let alive = true;
    const handle = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      void listCommunityProjects({ search, tags })
        .then(items => {
          if (!alive) return;
          setProjects(items);
          setLoading(false);
        })
        .catch(err => {
          if (!alive) return;
          setError(err instanceof Error ? err.message : "Unable to load community projects.");
          setLoading(false);
        });
    }, 180);

    return () => {
      alive = false;
      window.clearTimeout(handle);
    };
  }, [search, tags]);

  return (
    <PageShell theme={theme} eyebrow="Community" title="Community Projects" contentClassName="page-content--wide">
      <section className="community-toolbar page-card">
        <label>
          <span>Search</span>
          <input
            value={search}
            placeholder="Project, author, or description"
            onChange={event => setSearch(event.target.value)}
          />
        </label>
        <label>
          <span>Tags</span>
          <input
            value={tagInput}
            placeholder="timer, sequencing"
            onChange={event => setTagInput(event.target.value)}
          />
        </label>
      </section>

      {error && <div className="community-state community-state--error">{error}</div>}
      {loading && <div className="community-state">Loading community projects...</div>}
      {!loading && !error && projects.length === 0 && (
        <div className="community-state">No published projects match those filters.</div>
      )}

      <section className="community-grid" aria-label="Community projects">
        {projects.map(project => (
          <Link className="community-card" to={`/community/${project.id}`} key={project.id}>
            <div className="community-card-head">
              <h2>{project.title}</h2>
              <span>{new Date(project.updated_at).toLocaleDateString()}</span>
            </div>
            <p>{project.description || "No description provided."}</p>
            <LanguageMixBar project={project} />
            <div className="community-tags">
              {project.tags.length === 0 ? <em>No tags</em> : project.tags.map(tag => <span key={tag}>{tag}</span>)}
            </div>
            <div className="community-card-foot">
              <span>{project.author_display_name}</span>
              <time dateTime={project.updated_at}>Updated {new Date(project.updated_at).toLocaleDateString()}</time>
            </div>
          </Link>
        ))}
      </section>
    </PageShell>
  );
}

function LanguageMixBar({ project }: { project: CommunityProjectSummary }) {
  const mix = project.language_mix;
  const total = mix.ladderRoutines + mix.structuredTextRoutines;
  if (total === 0) {
    return (
      <div className="community-language-mix community-language-mix--empty">
        <span>No routines</span>
      </div>
    );
  }

  return (
    <div className="community-language-mix" aria-label={`${mix.ladderPercent}% ladder, ${mix.structuredTextPercent}% structured text`}>
      <div className="community-language-row">
        <span>LAD {mix.ladderPercent}%</span>
        <span>ST {mix.structuredTextPercent}%</span>
      </div>
      <div className="community-language-bar" aria-hidden="true">
        <span className="community-language-bar-lad" style={{ width: `${mix.ladderPercent}%` }} />
        <span className="community-language-bar-st" style={{ width: `${mix.structuredTextPercent}%` }} />
      </div>
      <div className="community-language-count">
        {mix.ladderRoutines} ladder / {mix.structuredTextRoutines} ST routines
      </div>
    </div>
  );
}
