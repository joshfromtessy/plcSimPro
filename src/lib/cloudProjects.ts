import type { PlcProject } from "../model/types";
import { supabase } from "./supabase";

export interface CloudProjectSummary {
  id: string;
  name: string;
  updated_at: string;
}

type CloudProjectRow = {
  id: string;
  name: string;
  updated_at: string;
  data: PlcProject;
};

export async function saveCloudProject(project: PlcProject, projectId?: string | null) {
  if (!supabase) throw new Error("Supabase is not configured yet.");

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!userData.user) throw new Error("Sign in before saving to cloud.");

  const payload = {
    id: projectId ?? crypto.randomUUID(),
    user_id: userData.user.id,
    name: project.name || "Untitled Project",
    data: project,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("projects")
    .upsert(payload)
    .select("id, name, updated_at")
    .single();

  if (error) throw error;
  return data as CloudProjectSummary;
}

export async function listCloudProjects() {
  if (!supabase) throw new Error("Supabase is not configured yet.");

  const { data, error } = await supabase
    .from("projects")
    .select("id, name, updated_at")
    .order("updated_at", { ascending: false });

  if (error) throw error;
  return (data ?? []) as CloudProjectSummary[];
}

export async function loadCloudProject(projectId: string) {
  if (!supabase) throw new Error("Supabase is not configured yet.");

  const { data, error } = await supabase
    .from("projects")
    .select("id, name, updated_at, data")
    .eq("id", projectId)
    .single();

  if (error) throw error;
  return (data as CloudProjectRow).data;
}
