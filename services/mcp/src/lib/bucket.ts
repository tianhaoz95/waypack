/**
 * File storage on Supabase Storage, so data and files live in one place (DECISIONS #56).
 * Implements the slice of R2's bucket API the Worker uses, so call sites read the same.
 * Bucket `waypack` (private) and the `storage_list` RPC come from supabase/migrations.
 */

export interface StoredObject {
  key: string;
  size: number;
  httpEtag: string;
  uploaded: Date;
}

export interface ObjectBody extends StoredObject {
  body: ReadableStream;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}

export type PutBody = ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob;

export interface Bucket {
  head(key: string): Promise<StoredObject | null>;
  get(key: string, opts?: { range?: { offset: number; length: number } }): Promise<ObjectBody | null>;
  put(key: string, body: PutBody, opts?: { httpMetadata?: { contentType?: string } }): Promise<void>;
  delete(keys: string | string[]): Promise<void>;
  /** Flat (recursive) listing by key prefix, in key order; pass `cursor` back for the next page. */
  list(opts: { prefix: string; cursor?: string }): Promise<{ objects: StoredObject[]; truncated: boolean; cursor?: string }>;
}

const PAGE = 1000;

export class SupabaseBucket implements Bucket {
  constructor(
    private readonly url: string,
    private readonly serviceKey: string,
    private readonly bucket = "waypack",
  ) {}

  private get auth() {
    return { apikey: this.serviceKey, Authorization: `Bearer ${this.serviceKey}` };
  }

  private objectUrl(key: string) {
    return `${this.url}/storage/v1/object/${this.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  private meta(key: string, res: Response, size: number): StoredObject {
    return {
      key,
      size,
      httpEtag: res.headers.get("ETag") ?? "",
      uploaded: new Date(res.headers.get("Last-Modified") ?? 0),
    };
  }

  /** Storage answers a missing object with 400 or 404 (body says not_found). */
  private static missing(res: Response) {
    return res.status === 404 || res.status === 400;
  }

  async head(key: string): Promise<StoredObject | null> {
    const res = await fetch(this.objectUrl(key), { method: "HEAD", headers: this.auth });
    if (SupabaseBucket.missing(res)) return null;
    if (!res.ok) throw new Error(`storage head ${key}: ${res.status}`);
    return this.meta(key, res, Number(res.headers.get("Content-Length") ?? 0));
  }

  async get(key: string, opts?: { range?: { offset: number; length: number } }): Promise<ObjectBody | null> {
    const headers: Record<string, string> = { ...this.auth };
    if (opts?.range) headers.Range = `bytes=${opts.range.offset}-${opts.range.offset + opts.range.length - 1}`;
    const res = await fetch(this.objectUrl(key), { headers });
    if (SupabaseBucket.missing(res)) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok || !res.body) throw new Error(`storage get ${key}: ${res.status} ${await res.text()}`);
    const total = res.headers.get("Content-Range")?.split("/")[1];
    const size = Number(total && total !== "*" ? total : (res.headers.get("Content-Length") ?? 0));
    return {
      ...this.meta(key, res, size),
      body: res.body,
      arrayBuffer: () => res.arrayBuffer(),
      text: () => res.text(),
      json: <T>() => res.json() as Promise<T>,
    };
  }

  async put(key: string, body: PutBody, opts?: { httpMetadata?: { contentType?: string } }): Promise<void> {
    // Storage needs a length; bodies here are bounded (bundles ≤ 25 MB), so buffer streams.
    const data = body instanceof ReadableStream ? await new Response(body).arrayBuffer() : body;
    const res = await fetch(this.objectUrl(key), {
      method: "POST",
      headers: {
        ...this.auth,
        "Content-Type": opts?.httpMetadata?.contentType ?? "application/octet-stream",
        "x-upsert": "true",
      },
      body: data as BodyInit,
    });
    if (!res.ok) throw new Error(`storage put ${key}: ${res.status} ${await res.text()}`);
    await res.body?.cancel();
  }

  async delete(keys: string | string[]): Promise<void> {
    const all = Array.isArray(keys) ? keys : [keys];
    for (let i = 0; i < all.length; i += PAGE) {
      const res = await fetch(`${this.url}/storage/v1/object/${this.bucket}`, {
        method: "DELETE",
        headers: { ...this.auth, "Content-Type": "application/json" },
        body: JSON.stringify({ prefixes: all.slice(i, i + PAGE) }),
      });
      if (!res.ok) throw new Error(`storage delete: ${res.status} ${await res.text()}`);
      await res.body?.cancel();
    }
  }

  async list(opts: { prefix: string; cursor?: string }) {
    // Storage's own list is one folder deep; the RPC lists every key under the prefix.
    const res = await fetch(`${this.url}/rest/v1/rpc/storage_list`, {
      method: "POST",
      headers: { ...this.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ p_bucket: this.bucket, p_prefix: opts.prefix, p_after: opts.cursor ?? "", p_limit: PAGE }),
    });
    if (!res.ok) throw new Error(`storage list: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as { name: string; size: number; created_at: string }[];
    const objects = rows.map((r) => ({ key: r.name, size: Number(r.size), httpEtag: "", uploaded: new Date(r.created_at) }));
    const truncated = rows.length === PAGE;
    return { objects, truncated, cursor: truncated ? rows[rows.length - 1].name : undefined };
  }
}
