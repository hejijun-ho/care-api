import { createAdminClient, requireUserId, type AdminClient, type SupabaseKeys } from "./orders.ts";
import { getSupabaseServiceConfig } from "../_shared/env.ts";

export type DatabaseRuntime = {
  config: SupabaseKeys;
  admin: AdminClient;
};

export type AuthenticatedDatabaseRuntime = DatabaseRuntime & {
  userId: string;
};

export function getSupabaseRuntimeConfig(): SupabaseKeys {
  return getSupabaseServiceConfig();
}

export function createDatabaseClient(
  config: SupabaseKeys = getSupabaseRuntimeConfig(),
): AdminClient {
  return createAdminClient(config);
}

export async function requireUserAndCreateDatabaseClient(
  req: Request,
  config: SupabaseKeys = getSupabaseRuntimeConfig(),
): Promise<AuthenticatedDatabaseRuntime> {
  const userId = await requireUserId(req, config);
  return {
    config,
    userId,
    admin: createDatabaseClient(config),
  };
}
