import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = pickEnv("VITE_SUPABASE_URL", "SUPABASE_URL");
const supabaseAnonKey = pickEnv("VITE_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY");

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);
export const missingSupabaseEnv = {
  url: !supabaseUrl,
  anonKey: !supabaseAnonKey,
};

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(supabaseUrl!, supabaseAnonKey!)
  : null;

function pickEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = import.meta.env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}
