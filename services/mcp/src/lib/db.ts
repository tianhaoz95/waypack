/**
 * Minimal PostgREST client using the service role (server-side only). Keeps the Worker
 * free of supabase-js and makes it trivial to fake in tests.
 */
export class Db {
  constructor(private url: string, private key: string, private fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  private async req<T>(method: string, path: string, body?: unknown, prefer?: string): Promise<T> {
    const res = await this.fetcher(`${this.url}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(prefer ? { Prefer: prefer } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new DbError(`${method} ${path.split("?")[0]}: ${res.status} ${text.slice(0, 300)}`, res.status);
    return (text ? JSON.parse(text) : null) as T;
  }

  select<T = Record<string, unknown>>(table: string, query = ""): Promise<T[]> {
    return this.req<T[]>("GET", `${table}${query ? `?${query}` : ""}`);
  }

  async one<T = Record<string, unknown>>(table: string, query: string): Promise<T | null> {
    const rows = await this.select<T>(table, `${query}&limit=1`);
    return rows[0] ?? null;
  }

  insert<T = Record<string, unknown>>(table: string, rows: object | object[], opts: { upsert?: boolean; onConflict?: string } = {}): Promise<T[]> {
    const prefer = ["return=representation", opts.upsert ? "resolution=merge-duplicates" : ""].filter(Boolean).join(",");
    const q = opts.onConflict ? `?on_conflict=${opts.onConflict}` : "";
    return this.req<T[]>("POST", `${table}${q}`, rows, prefer);
  }

  update<T = Record<string, unknown>>(table: string, query: string, patch: object): Promise<T[]> {
    return this.req<T[]>("PATCH", `${table}?${query}`, patch, "return=representation");
  }

  delete(table: string, query: string): Promise<unknown> {
    return this.req("DELETE", `${table}?${query}`);
  }

  /** Count rows matching a query using a HEAD-less trick (select id only). */
  async count(table: string, query: string): Promise<number> {
    return (await this.select<{ id: string }>(table, `select=id&${query}`)).length;
  }
}

export class DbError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export const eq = (v: string | number | boolean) => `eq.${encodeURIComponent(String(v))}`;
