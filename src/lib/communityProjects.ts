import type { PlcProject } from "../model/types";
import { genId } from "../model/ast";
import { supabase } from "./supabase";

export type CommunitySort = "recent" | "popular";

export interface CommunityProjectSummary {
  id: string;
  title: string;
  description: string;
  author_display_name: string;
  tags: string[];
  updated_at: string;
  clone_count: number;
}

export interface CommunityProjectDetail extends CommunityProjectSummary {
  owner_id: string;
  source_project_id: string;
  data: PlcProject;
  published_at: string;
}

export interface CommunityProjectFilters {
  search?: string;
  tags?: string[];
  sort?: CommunitySort;
}

export interface CommunityPublishMetadata {
  title: string;
  description: string;
  authorDisplayName: string;
  tags: string[];
}

type CommunityProjectRow = {
  id: string;
  owner_id: string;
  source_project_id: string;
  title: string;
  description: string;
  author_display_name: string;
  tags: string[] | null;
  data: PlcProject;
  published_at: string;
  updated_at: string;
  clone_count: number;
};

export async function listCommunityProjects(filters: CommunityProjectFilters = {}) {
  if (!supabase) throw new Error("Supabase is not configured yet.");

  const search = filters.search?.trim();
  const tags = normalizeTags(filters.tags ?? []);
  const sort = filters.sort ?? "recent";

  let query = supabase
    .from("community_projects")
    .select("id, title, description, author_display_name, tags, updated_at, clone_count")
    .eq("published", true);

  if (search) {
    const escaped = escapeIlike(search);
    query = query.or(`title.ilike.%${escaped}%,description.ilike.%${escaped}%,author_display_name.ilike.%${escaped}%`);
  }

  if (tags.length > 0) {
    query = query.contains("tags", tags);
  }

  query = sort === "popular"
    ? query.order("clone_count", { ascending: false }).order("updated_at", { ascending: false })
    : query.order("updated_at", { ascending: false });

  const { data, error } = await query.limit(60);
  if (error) throw error;
  return (data ?? []).map(toSummary);
}

export async function loadCommunityProject(id: string) {
  if (!supabase) throw new Error("Supabase is not configured yet.");

  const { data, error } = await supabase
    .from("community_projects")
    .select("id, owner_id, source_project_id, title, description, author_display_name, tags, data, published_at, updated_at, clone_count")
    .eq("id", id)
    .eq("published", true)
    .single();

  if (error) throw error;
  return toDetail(data as CommunityProjectRow);
}

export async function publishCommunityProject(project: PlcProject, metadata: CommunityPublishMetadata) {
  if (!supabase) throw new Error("Supabase is not configured yet.");

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!userData.user) throw new Error("Sign in before publishing to Community.");

  const title = metadata.title.trim() || project.name || "Untitled Project";
  const authorDisplayName = metadata.authorDisplayName.trim() || userData.user.email || "PLC Sim User";
  const now = new Date().toISOString();
  const payload = {
    owner_id: userData.user.id,
    source_project_id: project.id,
    title,
    description: metadata.description.trim(),
    author_display_name: authorDisplayName,
    tags: normalizeTags(metadata.tags),
    data: project,
    published: true,
    updated_at: now,
  };

  const { data, error } = await supabase
    .from("community_projects")
    .upsert(payload, { onConflict: "owner_id,source_project_id" })
    .select("id, title, description, author_display_name, tags, updated_at, clone_count")
    .single();

  if (error) throw error;
  return toSummary(data as Omit<CommunityProjectRow, "owner_id" | "source_project_id" | "data" | "published_at">);
}

export async function unpublishCommunityProject(projectId: string) {
  if (!supabase) throw new Error("Supabase is not configured yet.");

  const { error } = await supabase
    .from("community_projects")
    .update({ published: false, updated_at: new Date().toISOString() })
    .eq("id", projectId);

  if (error) throw error;
}

export async function listMyCommunityProjects() {
  if (!supabase) throw new Error("Supabase is not configured yet.");

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!userData.user) return [];

  const { data, error } = await supabase
    .from("community_projects")
    .select("id, title, description, author_display_name, tags, updated_at, clone_count")
    .eq("owner_id", userData.user.id)
    .eq("published", true)
    .order("updated_at", { ascending: false });

  if (error) throw error;
  return (data ?? []).map(toSummary);
}

export async function incrementCloneCount(projectId: string) {
  if (!supabase) return;
  await supabase.rpc("increment_community_project_clone_count", { project_id: projectId });
}

export function cloneCommunityProject(project: PlcProject): PlcProject {
  const now = new Date().toISOString();
  return {
    ...JSON.parse(JSON.stringify(project)) as PlcProject,
    id: genId("proj"),
    name: `Copy of ${project.name || "Community Project"}`,
    createdAt: now,
    modifiedAt: now,
  };
}

export function parseTagInput(value: string) {
  return normalizeTags(value.split(","));
}

function toSummary(row: {
  id: string;
  title: string;
  description: string;
  author_display_name: string;
  tags: string[] | null;
  updated_at: string;
  clone_count: number;
}): CommunityProjectSummary {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    author_display_name: row.author_display_name,
    tags: row.tags ?? [],
    updated_at: row.updated_at,
    clone_count: row.clone_count,
  };
}

function toDetail(row: CommunityProjectRow): CommunityProjectDetail {
  return {
    ...toSummary(row),
    owner_id: row.owner_id,
    source_project_id: row.source_project_id,
    data: row.data,
    published_at: row.published_at,
  };
}

function normalizeTags(tags: string[]) {
  return Array.from(
    new Set(
      tags
        .map(tag => tag.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 8)
    )
  );
}

function escapeIlike(value: string) {
  return value.replace(/[%_]/g, match => `\\${match}`);
}
