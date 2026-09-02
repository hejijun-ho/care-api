import assert from "node:assert/strict";

export async function responseText(response: Response): Promise<string> {
  return await response.clone().text();
}

export async function expectStatus(
  response: Response,
  expected: number | number[],
  label = "response",
): Promise<void> {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(response.status)) {
    const body = await responseText(response);
    assert.fail(
      `${label}: expected status ${allowed.join("/")}, got ${response.status}. Body: ${body}`,
    );
  }
}

export async function readJson<T = Record<string, unknown>>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error("clientBackUrl is invalid", { cause: error });
  }
}

export async function expectJson<T = Record<string, unknown>>(
  response: Response,
  expectedStatus = 200,
  label = "response",
): Promise<T> {
  await expectStatus(response, expectedStatus, label);
  return await readJson<T>(response);
}

export function assertString(value: unknown, label: string): string {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.notEqual(String(value).trim(), "", `${label} must not be empty`);
  return String(value);
}

export function assertTruthy(value: unknown, label: string): void {
  assert.ok(value, label);
}

export function assertIncludes(haystack: string, needle: string, label = "text"): void {
  assert.ok(haystack.includes(needle), `${label} should include ${needle}; actual: ${haystack}`);
}
