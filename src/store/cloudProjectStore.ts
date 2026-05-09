import { create } from "zustand";
import type { PlcProject } from "../model/types";
import {
  listCloudProjects,
  loadCloudProject,
  saveCloudProject,
  type CloudProjectSummary,
} from "../lib/cloudProjects";

interface CloudProjectState {
  currentProjectId: string | null;
  projects: CloudProjectSummary[];
  loading: boolean;
  error: string | null;
  lastSavedAt: string | null;
  setCurrentProjectId: (id: string | null) => void;
  refreshProjects: () => Promise<void>;
  saveCurrentProject: (project: PlcProject) => Promise<void>;
  loadProjectById: (id: string) => Promise<PlcProject | null>;
  clearError: () => void;
}

export const useCloudProjectStore = create<CloudProjectState>((set, get) => ({
  currentProjectId: null,
  projects: [],
  loading: false,
  error: null,
  lastSavedAt: null,

  setCurrentProjectId: (id) => set({ currentProjectId: id }),

  refreshProjects: async () => {
    set({ loading: true, error: null });
    try {
      const projects = await listCloudProjects();
      set({ projects, loading: false });
    } catch (err) {
      set({ loading: false, error: getErrorMessage(err) });
    }
  },

  saveCurrentProject: async (project) => {
    set({ loading: true, error: null });
    try {
      const saved = await saveCloudProject(project, get().currentProjectId);
      const projects = await listCloudProjects();
      set({
        currentProjectId: saved.id,
        projects,
        loading: false,
        lastSavedAt: saved.updated_at,
      });
    } catch (err) {
      set({ loading: false, error: getErrorMessage(err) });
    }
  },

  loadProjectById: async (id) => {
    set({ loading: true, error: null });
    try {
      const project = await loadCloudProject(id);
      set({ currentProjectId: id, loading: false });
      return project;
    } catch (err) {
      set({ loading: false, error: getErrorMessage(err) });
      return null;
    }
  },

  clearError: () => set({ error: null }),
}));

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Cloud project operation failed.";
}
