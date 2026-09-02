export type EdgeHandler = (req: Request) => Response | Promise<Response>;
export type HandlerMap = Record<string, EdgeHandler>;

function functionUrl(functionName: string): string {
  const base = (process.env.FUNCTIONS_PUBLIC_URL || "https://functions.test/functions/v1").replace(
    /\/+$/,
    "",
  );
  return `${base}/${functionName}`;
}

export function jsonRequest(
  functionName: string,
  body?: unknown,
  options: { method?: string; accessToken?: string; headers?: Record<string, string> } = {},
): Request {
  const method = options.method ?? "POST";
  const headers = new Headers(options.headers ?? {});
  headers.set("Content-Type", "application/json");
  if (options.accessToken) headers.set("Authorization", `Bearer ${options.accessToken}`);

  return new Request(functionUrl(functionName), {
    method,
    headers,
    body:
      body === undefined || method === "GET" || method === "HEAD"
        ? undefined
        : JSON.stringify(body),
  });
}

export function formRequest(
  functionName: string,
  fields: Record<string, unknown>,
  options: { method?: string; accessToken?: string; headers?: Record<string, string> } = {},
): Request {
  const method = options.method ?? "POST";
  const headers = new Headers(options.headers ?? {});
  headers.set("Content-Type", "application/x-www-form-urlencoded");
  if (options.accessToken) headers.set("Authorization", `Bearer ${options.accessToken}`);

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }

  return new Request(functionUrl(functionName), {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : params,
  });
}

export async function callJson(
  handlers: HandlerMap,
  functionName: string,
  body?: unknown,
  options: { method?: string; accessToken?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const handler = handlers[functionName];
  if (!handler) throw new Error(`Unknown function handler: ${functionName}`);
  return await handler(jsonRequest(functionName, body, options));
}

export async function callForm(
  handlers: HandlerMap,
  functionName: string,
  fields: Record<string, unknown>,
  options: { method?: string; accessToken?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const handler = handlers[functionName];
  if (!handler) throw new Error(`Unknown function handler: ${functionName}`);
  return await handler(formRequest(functionName, fields, options));
}
