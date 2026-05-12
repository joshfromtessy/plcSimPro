import { create } from "zustand";
import type { Session, User } from "@supabase/supabase-js";
import { isSupabaseConfigured, supabase } from "../lib/supabase";

interface AuthState {
  loading: boolean;
  session: Session | null;
  user: User | null;
  error: string | null;
  initialized: boolean;
  initialize: () => Promise<void>;
  signIn: (email: string, password: string, captchaToken?: string) => Promise<void>;
  signUp: (email: string, password: string, captchaToken?: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  loading: false,
  session: null,
  user: null,
  error: null,
  initialized: false,

  initialize: async () => {
    if (get().initialized) return;
    if (!isSupabaseConfigured || !supabase) {
      set({ initialized: true, session: null, user: null });
      return;
    }

    set({ loading: true, error: null });
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      set({ loading: false, initialized: true, error: error.message });
      return;
    }

    set({
      loading: false,
      initialized: true,
      session: data.session,
      user: data.session?.user ?? null,
    });

    supabase.auth.onAuthStateChange((_event, session) => {
      set({ session, user: session?.user ?? null });
    });
  },

  signIn: async (email, password, captchaToken) => {
    if (!supabase) {
      set({ error: "Supabase is not configured yet." });
      return;
    }

    set({ loading: true, error: null });
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
      options: captchaToken ? { captchaToken } : undefined,
    });
    set({ loading: false, error: error?.message ?? null });
  },

  signUp: async (email, password, captchaToken) => {
    if (!supabase) {
      set({ error: "Supabase is not configured yet." });
      return;
    }

    set({ loading: true, error: null });
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: captchaToken ? { captchaToken } : undefined,
    });
    set({ loading: false, error: error?.message ?? null });
  },

  signInWithGoogle: async () => {
    if (!supabase) {
      set({ error: "Supabase is not configured yet." });
      return;
    }

    set({ loading: true, error: null });
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/`,
      },
    });
    if (error) set({ loading: false, error: error.message });
  },

  signOut: async () => {
    if (!supabase) return;
    set({ loading: true, error: null });
    const { error } = await supabase.auth.signOut();
    set({ loading: false, error: error?.message ?? null });
  },

  clearError: () => set({ error: null }),
}));
