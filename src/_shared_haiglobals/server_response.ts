import type { ServerResponse } from "node:http";
import { Buffer } from "node:buffer";

export async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }

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

export function createJsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export async function sendJsonResponse(
  res: ServerResponse,
  payload: unknown,
  status = 200,
): Promise<void> {
  await sendWebResponse(res, createJsonResponse(payload, status));
}
