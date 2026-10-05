import { describe, expect, it } from "vitest";
import { SupabaseBucket } from "../src/lib/bucket.js";

// Against a running local Supabase (`supabase start`):
//   WAYPACK_STORAGE_IT=1 SUPABASE_SERVICE_ROLE_KEY=$(grep ^SUPABASE_SERVICE_ROLE_KEY= .dev.vars | cut -d= -f2-) \
//     npx vitest run test/bucket.test.ts
declare const process: { env: Record<string, string | undefined> };
const run = !!process.env.WAYPACK_STORAGE_IT;
const key = () => process.env.SUPABASE_SERVICE_ROLE_KEY!;

describe.skipIf(!run)("SupabaseBucket (local Supabase Storage)", () => {
  const b = run ? new SupabaseBucket(process.env.SUPABASE_URL ?? "http://127.0.0.1:55421", key()) : (null as never);
  const root = `it-${Date.now()}/`;

  it("put / head / get / range", async () => {
    await b.put(`${root}a/one.txt`, "hello world", { httpMetadata: { contentType: "text/plain" } });
    const h = await b.head(`${root}a/one.txt`);
    expect(h?.size).toBe(11);
    expect(h?.httpEtag).not.toBe("");
    expect(await (await b.get(`${root}a/one.txt`))!.text()).toBe("hello world");
    const part = await b.get(`${root}a/one.txt`, { range: { offset: 6, length: 5 } });
    expect(await part!.text()).toBe("world");
    expect(part!.size).toBe(11);
  });

  it("streams in, overwrites, binary-safe", async () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    await b.put(`${root}a/bin`, new Response(bytes).body!);
    await b.put(`${root}a/bin`, bytes.slice(0, 100)); // upsert
    expect(new Uint8Array(await (await b.get(`${root}a/bin`))!.arrayBuffer())).toEqual(bytes.slice(0, 100));
  });

  it("missing objects are null", async () => {
    expect(await b.head(`${root}nope`)).toBeNull();
    expect(await b.get(`${root}nope`)).toBeNull();
  });

  it("lists recursively by prefix, then deletes", async () => {
    await b.put(`${root}a/b/c/deep.json`, JSON.stringify({ x: 1 }), { httpMetadata: { contentType: "application/json" } });
    await b.put(`${root}other.txt`, "x");
    const l = await b.list({ prefix: `${root}a/` });
    expect(l.objects.map((o) => o.key)).toEqual([`${root}a/b/c/deep.json`, `${root}a/bin`, `${root}a/one.txt`]);
    expect(l.truncated).toBe(false);
    expect(await (await b.get(`${root}a/b/c/deep.json`))!.json()).toEqual({ x: 1 });
    await b.delete(l.objects.map((o) => o.key));
    await b.delete(`${root}other.txt`);
    expect((await b.list({ prefix: root })).objects).toEqual([]);
  });
});
