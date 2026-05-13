import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PageShell } from "../components/PageShell";
import {
  listCommunityProjects,
  parseTagInput,
  type CommunityProjectSummary,
  type CommunitySort,
} from "../lib/communityProjects";

interface CommunityPageProps {
  theme: "dark" | "light";
}

export function CommunityPage({ theme }: CommunityPageProps) {
  const [projects, setProjects] = useState<CommunityProjectSummary[]>([]);
  const [search, setSearch] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [sort, setSort] = useState<CommunitySort>("recent");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const tags = useMemo(() => parseTagInput(tagInput), [tagInput]);

  useEffect(() => {
    let alive = true;
    const handle = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      void listCommunityProjects({ search, tags, sort })
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
  }, [search, tags, sort]);

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
        <label>
          <span>Sort</span>
          <select value={sort} onChange={event => setSort(event.target.value as CommunitySort)}>
            <option value="recent">Recent</option>
            <option value="popular">Popular</option>
          </select>
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
              <span>{project.clone_count} clones</span>
            </div>
            <p>{project.description || "No description provided."}</p>
            <div className="community-tags">
              {project.tags.length === 0 ? <em>No tags</em> : project.tags.map(tag => <span key={tag}>{tag}</span>)}
            </div>
            <div className="community-card-foot">
              <span>{project.author_display_name}</span>
              <time dateTime={project.updated_at}>{new Date(project.updated_at).toLocaleDateString()}</time>
            </div>
          </Link>
        ))}
      </section>
    </PageShell>
  );
}
