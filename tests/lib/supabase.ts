import assert from "node:assert/strict";

export type QueryValue = string | number | boolean;

type SupabaseConfig = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
};

export type AuthSession = {
  accessToken: string;
  refreshToken?: string;
  userId: string;
  raw: Record<string, unknown>;
};

function encodeFilterValue(value: QueryValue): string {
  return encodeURIComponent(String(value));
}

export function queryString(params: Record<string, QueryValue>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeFilterValue(value)}`)
    .join("&");
}

function extractMissingColumnName(errorText: string): string {
  const patterns = [
    /could not find the '([^']+)' column/i,
    /column [a-z_]+\.([a-z_]+) does not exist/i,
    /column "([^"]+)" of relation "[^"]+" does not exist/i,
    /cannot insert a non-DEFAULT value into column "([^"]+)"/i,
    /column "([^"]+)" can only be updated to DEFAULT/i,
    /cannot update generated column "([^"]+)"/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(errorText);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function extractGeneratedColumnName(errorText: string): string {
  const patterns = [
    /cannot insert a non-DEFAULT value into column "([^"]+)"/i,
    /column "([^"]+)" is a generated column/i,
    /generated column "([^"]+)"/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(errorText);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function payloadHasColumn(
  payload: Record<string, unknown> | Array<Record<string, unknown>>,
  column: string,
): boolean {
  if (Array.isArray(payload)) return payload.some((row) => column in row);
  return column in payload;
}

function dropColumn<T extends Record<string, unknown> | Array<Record<string, unknown>>>(
  payload: T,
  column: string,
): T {
  if (Array.isArray(payload)) {
    return payload.map((row) => {
      const next = { ...row };
      delete next[column];
      return next;
    }) as T;
  }
  const next = { ...payload };
  delete next[column];
  return next as T;
}

async function responseError(response: Response): Promise<Error> {
  const text = await response.text();
  return new Error(text || `Supabase REST request failed (${response.status})`);
}

export class SupabaseTestClient {
  readonly config: SupabaseConfig;

  constructor(config: SupabaseConfig) {
    this.config = {
      ...config,
      supabaseUrl: config.supabaseUrl.replace(/\/+$/, ""),
    };
  }

  async signInWithPhonePassword(phone: string, password: string): Promise<AuthSession> {
    const response = await fetch(`${this.config.supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        apikey: this.config.supabaseAnonKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ phone, password }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to sign in test user by phone. Check TEST_USER_PHONE / TEST_USER_PASSWORD and Supabase phone auth. ` +
          `Status=${response.status}; Body=${text}`,
      );
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const accessToken = String(payload.access_token ?? "").trim();
    const refreshToken = String(payload.refresh_token ?? "").trim();
    const user =
      payload.user && typeof payload.user === "object"
        ? (payload.user as Record<string, unknown>)
        : {};
    const userId = String(user.id ?? payload.user_id ?? payload.sub ?? "").trim();

    assert.ok(accessToken, "Supabase auth response did not include access_token");
    assert.ok(userId, "Supabase auth response did not include user id");

    return { accessToken, refreshToken, userId, raw: payload };
  }

  async restRequest<T>(table: string, query = "", init: RequestInit = {}): Promise<T> {
    const url = `${this.config.supabaseUrl}/rest/v1/${table}${query ? `?${query}` : ""}`;
    const headers = new Headers(init.headers);
    headers.set("apikey", this.config.supabaseServiceRoleKey);
    headers.set("Authorization", `Bearer ${this.config.supabaseServiceRoleKey}`);
    headers.set("Content-Type", "application/json");
    headers.set("Accept-Profile", "haiglobals");
    headers.set("Content-Profile", "haiglobals");

    const response = await fetch(url, { ...init, headers });
    if (!response.ok) throw await responseError(response);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async selectRows<T>(table: string, params: Record<string, QueryValue>): Promise<T[]> {
    return await this.restRequest<T[]>(table, queryString(params));
  }

  async selectOne<T>(table: string, params: Record<string, QueryValue>): Promise<T | null> {
    const rows = await this.selectRows<T>(table, { ...params, limit: 1 });
    return rows[0] ?? null;
  }

  async insertRows<T>(
    table: string,
    payload: Record<string, unknown> | Array<Record<string, unknown>>,
    options: { adaptive?: boolean } = { adaptive: true },
  ): Promise<T[]> {
    let currentPayload = payload;
    const droppedColumns: string[] = [];

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await fetch(`${this.config.supabaseUrl}/rest/v1/${table}`, {
        method: "POST",
        headers: {
          apikey: this.config.supabaseServiceRoleKey,
          Authorization: `Bearer ${this.config.supabaseServiceRoleKey}`,
          "Content-Type": "application/json",
          "Accept-Profile": "haiglobals",
          "Content-Profile": "haiglobals",
          Prefer: "return=representation",
        },
        body: JSON.stringify(currentPayload),
      });

      if (response.ok) return (await response.json()) as T[];

      const text = await response.text();
      const adaptiveColumn = options.adaptive
        ? extractMissingColumnName(text) || extractGeneratedColumnName(text)
        : "";
      if (adaptiveColumn && payloadHasColumn(currentPayload, adaptiveColumn)) {
        droppedColumns.push(adaptiveColumn);
        currentPayload = dropColumn(currentPayload, adaptiveColumn);
        continue;
      }

      const detail = droppedColumns.length
        ? ` Dropped missing columns before failing: ${droppedColumns.join(", ")}.`
        : "";
      throw new Error(`Insert into ${table} failed (${response.status}): ${text}.${detail}`);
    }

    throw new Error(`Insert into ${table} failed after repeatedly dropping missing columns`);
  }

  async insertOne<T>(
    table: string,
    payload: Record<string, unknown>,
    options: { adaptive?: boolean } = { adaptive: true },
  ): Promise<T> {
    const rows = await this.insertRows<T>(table, payload, options);
    const row = rows[0];
    if (!row) throw new Error(`Insert into ${table} returned no rows`);
    return row;
  }

  async patchRows(
    table: string,
    filters: Record<string, QueryValue>,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.restRequest<void>(table, queryString(filters), {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ ...payload, updated_at: new Date().toISOString() }),
    });
  }

  async deleteRows(table: string, filters: Record<string, QueryValue>): Promise<void> {
    await this.restRequest<void>(table, queryString(filters), {
      method: "DELETE",
      headers: { Prefer: "return=minimal" },
    });
  }

  async countRows(table: string, filters: Record<string, QueryValue>): Promise<number> {
    const rows = await this.selectRows<Record<string, unknown>>(table, {
      select: "id",
      ...filters,
    });
    return rows.length;
  }
}

export class CleanupTracker {
  private tasks: Array<{ label: string; fn: () => Promise<void> }> = [];

  defer(label: string, fn: () => Promise<void>): void {
    this.tasks.push({ label, fn });
  }

  get size(): number {
    return this.tasks.length;
  }

  async run(): Promise<void> {
    const tasks = [...this.tasks].reverse();
    this.tasks = [];
    const failures: string[] = [];

    for (const task of tasks) {
      try {
        await task.fn();
      } catch (error) {
        failures.push(`${task.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (failures.length > 0) {
      console.warn("Cleanup finished with warnings:");
      for (const failure of failures) console.warn(`  - ${failure}`);
      throw new Error("Cleanup failed for " + failures.length + " task(s): " + failures.join("; "));
    }
  }
}
