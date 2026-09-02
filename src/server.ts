// src/server.ts

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Buffer } from "node:buffer";
import { readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

type EdgeHandler = (req: Request) => Response | Promise<Response>;
type HandlerMap = Record<string, EdgeHandler>;

const FUNCTIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "functions");

// 每支 API 一個檔案：src/functions/<function-name>.ts，default export 為 handler。
// 新增 API 只要新增檔案，不需要在這裡登記。
async function loadHandlers(): Promise<HandlerMap> {
  const entries = await readdir(FUNCTIONS_DIR, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.startsWith("_"))
    .map((entry) => entry.name.slice(0, -".ts".length))
    .sort();

  const loaded = await Promise.all(
    names.map(async (name) => {
      const module = (await import(pathToFileURL(join(FUNCTIONS_DIR, `${name}.ts`)).href)) as {
        default?: unknown;
      };
      if (typeof module.default !== "function") {
        throw new Error(`functions/${name}.ts 缺少 default export handler`);
      }
      return [name, module.default as EdgeHandler] as const;
    }),
  );

  return Object.fromEntries(loaded);
}

const handlers = await loadHandlers();
const functionNames = Object.keys(handlers);

function getPublicOrigin(req: IncomingMessage): string {
  const proto = String(req.headers["x-forwarded-proto"] ?? "http")
    .split(",")[0]
    .trim();
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? `localhost:${PORT}`)
    .split(",")[0]
    .trim();
  return `${proto}://${host}`;
}

function resolveFunctionName(pathname: string): string | undefined {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "functions" && parts[1] === "v1") {
    return parts[2];
  }
  return parts[0];
}

async function readNodeRequestBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const origin = getPublicOrigin(req);
  const url = new URL(req.url ?? "/", origin);
  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (typeof value === "string") {
      headers.set(key, value);
    }
  }

  const body = await readNodeRequestBody(req);
  return new Request(url, {
    method: req.method,
    headers,
    body,
    duplex: body ? "half" : undefined,
  } as RequestInit & { duplex?: "half" });
}

async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  res.statusMessage = response.statusText;

  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (!response.body) {
    res.end();
    return;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  res.end(buffer);
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 9000);

// 環境防呆：ENVIRONMENT 必須和 SUPABASE_URL 對得上，避免「測試程式碼打到正式庫」或反過來。
//   production ↔ https://api.haiglobals.com、staging ↔ https://api-staging.haiglobals.com
// 對不上就拒絕啟動（容器會 restart loop，docker logs 看得到原因），而不是默默跑錯庫。
function assertEnvironmentMatchesSupabaseUrl(): void {
  const environment = (process.env.ENVIRONMENT ?? "").trim().toLowerCase();
  const supabaseUrl = (process.env.SUPABASE_URL ?? "").trim();
  let host = "";
  try {
    host = new URL(supabaseUrl).host;
  } catch {
    host = "";
  }
  const looksStaging = host.startsWith("api-staging.");
  const looksProduction = host === "api.haiglobals.com";
  const ok =
    (environment === "production" && looksProduction) ||
    (environment === "staging" && looksStaging) ||
    (environment !== "production" && environment !== "staging" && host !== ""); // dev/local: 不限制
  if (!ok) {
    console.error(
      `[care-api] refusing to start: ENVIRONMENT=${environment || "(unset)"} does not match SUPABASE_URL=${supabaseUrl || "(unset)"}`,
    );
    process.exit(1);
  }
}
assertEnvironmentMatchesSupabaseUrl();

const server = createServer(async (req, res) => {
  try {
    const origin = getPublicOrigin(req);
    const url = new URL(req.url ?? "/", origin);

    if (url.pathname === "/" || url.pathname === "/healthz") {
      await sendWebResponse(res, jsonResponse({ ok: true, functions: functionNames }));
      return;
    }

    const functionName = resolveFunctionName(url.pathname);
    const handler = functionName ? handlers[functionName] : undefined;

    if (!functionName || !handler) {
      await sendWebResponse(
        res,
        jsonResponse(
          {
            error: "Function not found",
            functionName: functionName ?? null,
            supportedPaths: ["/functions/v1/:functionName", "/:functionName"],
            functions: functionNames,
          },
          404,
        ),
      );
      return;
    }

    const webRequest = await toWebRequest(req);
    const webResponse = await handler(webRequest);
    await sendWebResponse(res, webResponse);
  } catch (error) {
    console.error(error);
    await sendWebResponse(
      res,
      jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500),
    );
  }
});

server.listen(PORT, HOST, () => {
  console.log(`haiglobals functions server listening on http://${HOST}:${PORT}`);
});
