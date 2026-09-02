import { corsHeaders, handleCors } from "../_shared_haiglobals/cors.ts";
import { createDatabaseClient, getSupabaseRuntimeConfig } from "../_shared_haiglobals/database.ts";
import { deleteRows } from "../_shared_haiglobals/orders.ts";

type SupabaseUser = {
  id: string;
  email?: string | null;
  phone?: string | null;
};

const handleRequest = async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "POST") {
    return json({ success: false, error: "Method not allowed" }, 405);
  }

  const authorization = req.headers.get("Authorization");
  if (!authorization) {
    return json({ success: false, error: "Missing authorization header" }, 401);
  }

  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return json({ success: false, error: "Missing bearer token" }, 401);
  }

  let supabaseUrl: string;
  let anonKey: string;
  let serviceRoleKey: string;
  try {
    const config = getSupabaseRuntimeConfig();
    supabaseUrl = config.supabaseUrl;
    anonKey = config.supabaseAnonKey;
    serviceRoleKey = config.supabaseServiceRoleKey;
  } catch (error) {
    return json({ success: false, error: errorMessage(error) }, 500);
  }

  let user: SupabaseUser;
  try {
    user = await fetchAuthenticatedUser({ supabaseUrl, anonKey, token });
  } catch (_) {
    return json({ success: false, error: "Invalid or expired session" }, 401);
  }

  try {
    console.log("[delete-account] before deleteUser", {
      user_id: user.id,
      email: user.email,
      phone: user.phone,
    });

    // 先清推播註冊再刪帳號。
    // 這裡是 soft delete，auth.users 那列還在，所以 push_registrations 的
    // on delete cascade 不會觸發，必須自己清掉，否則刪過帳號的裝置會繼續收推播。
    // 放在刪帳號之前：萬一刪帳號失敗，使用者只是暫時收不到推播，下次開 App 會自動重新註冊；
    // 反過來若先刪帳號才清，清失敗就會留下永遠收得到推播的孤兒註冊。
    await deletePushRegistrations(user.id);

    await deleteSupabaseUser({ supabaseUrl, serviceRoleKey, userId: user.id });

    console.log("[delete-account] after deleteUser", {
      user_id: user.id,
    });

    return json(
      {
        success: true,
        deleted_user_id: user.id,
      },
      200,
    );
  } catch (error) {
    const message = errorMessage(error);
    console.error("[delete-account] deleteUser failed", {
      user_id: user.id,
      message,
    });
    return json({ success: false, error: message }, 500);
  }
};

export default handleRequest;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchAuthenticatedUser(input: {
  supabaseUrl: string;
  anonKey: string;
  token: string;
}): Promise<SupabaseUser> {
  const response = await fetch(`${input.supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: input.anonKey,
      Authorization: `Bearer ${input.token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Supabase user lookup failed (${response.status})`);
  }

  const user = (await response.json()) as SupabaseUser;
  if (!user.id) {
    throw new Error("Supabase user lookup did not return a user id");
  }
  return user;
}

async function deletePushRegistrations(userId: string): Promise<void> {
  // 帳號要刪了，推播註冊沒有保留價值，直接硬刪並釋放 (app_code, fcm_token) 唯一鍵。
  // 清理失敗不阻擋刪帳號本身，只留 warn log。
  try {
    await deleteRows(createDatabaseClient(), "push_registrations", {
      user_id: `eq.${userId}`,
    });
    console.log("[delete-account] push registrations deleted", { user_id: userId });
  } catch (error) {
    console.warn("[delete-account] push registration cleanup failed", {
      user_id: userId,
      message: errorMessage(error),
    });
  }
}

async function deleteSupabaseUser(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  userId: string;
}): Promise<void> {
  const response = await fetch(
    `${input.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(input.userId)}`,
    {
      method: "DELETE",
      headers: {
        apikey: input.serviceRoleKey,
        Authorization: `Bearer ${input.serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ should_soft_delete: true }),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Supabase delete user failed (${response.status})`);
  }
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}
