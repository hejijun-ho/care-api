export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, bypass-tunnel-reminder",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function handleCors(req: Request): Response | null {
  if (req.method !== "OPTIONS") {
    return null;
  }

  return new Response("ok", { headers: corsHeaders });
}
