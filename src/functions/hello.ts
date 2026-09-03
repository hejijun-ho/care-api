import { corsHeaders, handleCors } from "../_shared_haiglobals/cors.ts";

type EnvSnapshotItem = {
  name: string;
  exists: boolean;
  value: string | null;
};

const PRINT_ENV_NAMES = [
  "NODE_ENV",
  "HOST",
  "PORT",
  "SUPABASE_URL",
  "SUPABASE_PUBLIC_URL",
  "FUNCTIONS_PUBLIC_URL",
  "DB_SCHEMA",
  "ECPAY_MERCHANT_ID",
] as const;

// 正式環境只回報「有沒有設」，不回傳值（例如綠界商店代號），避免對外的健康檢查端點洩漏設定。
const IS_PRODUCTION = (process.env.ENVIRONMENT ?? "").trim().toLowerCase() === "production";

function readEnvSnapshot(): EnvSnapshotItem[] {
  return PRINT_ENV_NAMES.map((name) => {
    const rawValue = process.env[name]?.trim();

    return {
      name,
      exists: Boolean(rawValue),
      value: IS_PRODUCTION ? null : rawValue || null,
    };
  });
}

export default async function handler(req: Request): Promise<Response> {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }

  const snapshot = readEnvSnapshot();

  console.log("[hello] request", {
    method: req.method,
    url: req.url,
  });

  console.log("[hello] env snapshot", snapshot);

  return new Response(
    JSON.stringify({
      ok: true,
      message: "hello from src/functions/hello.ts",
      method: req.method,
      url: req.url,
      env: snapshot,
    }),
    {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json; charset=utf-8",
      },
    },
  );
}
