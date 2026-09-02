type AdminClientLike = {
  keys: {
    supabaseUrl: string;
    supabaseAnonKey?: string;
    supabaseServiceRoleKey: string;
  };
};

function normalizeSupabaseUrl(value: string): string {
  const normalized = String(value ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!normalized) throw new Error("SUPABASE_URL is required");
  return normalized;
}

function normalizeServiceRoleKey(value: string, anonKey?: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
  if (anonKey && normalized === String(anonKey ?? "").trim()) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY must not be the anon key");
  }
  return normalized;
}

async function callIsAdminUserRpc(
  admin: AdminClientLike,
  payload: Record<string, string>,
): Promise<{ ok: true; value: boolean } | { ok: false; errorText: string; status: number }> {
  const serviceRoleKey = normalizeServiceRoleKey(
    admin.keys.supabaseServiceRoleKey,
    admin.keys.supabaseAnonKey,
  );
  const response = await fetch(
    `${normalizeSupabaseUrl(admin.keys.supabaseUrl)}/rest/v1/rpc/is_admin_user`,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        "Accept-Profile": "haiglobals",
        "Content-Profile": "haiglobals",
      },
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    return { ok: false, status: response.status, errorText: await response.text() };
  }

  const data = await response.json();
  return { ok: true, value: data === true || data === "true" };
}

export async function isAdminUser(admin: AdminClientLike, userId: string): Promise<boolean> {
  const normalizedUserId = String(userId ?? "").trim();
  if (!normalizedUserId) return false;

  const attempts = [{ user_id: normalizedUserId }, { p_user_id: normalizedUserId }];
  let lastError = "";

  for (const payload of attempts) {
    const result = await callIsAdminUserRpc(admin, payload);
    if (result.ok === true) return result.value;
    lastError = result.errorText;
    if (!/parameter|argument|function|does not exist|schema cache/i.test(result.errorText)) {
      break;
    }
  }

  throw new Error(lastError || "Failed to check admin privileges");
}

export async function requireAdminUser(admin: AdminClientLike, userId: string): Promise<void> {
  if (!(await isAdminUser(admin, userId))) {
    throw new Error("Admin privileges required");
  }
}
