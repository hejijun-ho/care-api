function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export type SupabaseServiceConfig = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
};

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function optionalEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

export function getSupabaseServiceConfig(): SupabaseServiceConfig {
  return {
    supabaseUrl: trimTrailingSlash(requireEnv("SUPABASE_URL")),
    supabaseAnonKey: requireEnv("SUPABASE_ANON_KEY"),
    supabaseServiceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  };
}
