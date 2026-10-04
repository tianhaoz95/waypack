import { describe, expect, it } from "vitest";
import { htmlToText, redactBundle, redactText, tokenFrom } from "../src/lib/shares.js";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (u: Uint8Array) => new TextDecoder().decode(u);

describe("redaction", () => {
  it("masks booking references in their common shapes", () => {
    const cases: [string, string][] = [
      ["Confirmation #ABC123.", "Confirmation #••••."],
      ["Confirmation: 7781-2290", "Confirmation: ••••"],
      ["conf # QX7T2L", "conf # ••••"],
      ["Reservation no. 55-1234 (2 nights)", "Reservation no. ••••"],
      ["Booking ref: HK44921", "Booking ref: ••••"],
      ["PNR: QX7T2L", "PNR: ••••"],
      ["record locator ZZ9P1Q", "record locator ••••"],
    ];
    for (const [input, out] of cases) expect(redactText(input).text.startsWith(out.replace(/ \(2 nights\)$/, "")), input).toBe(true);
    expect(redactText("Confirmation #ABC123 and booking 9981XQ").count).toBe(2);
  });
  it("leaves ordinary words and business details alone", () => {
    for (const s of [
      "Reservation recommended for Saturday.",
      "Booking opens 60 days ahead.",
      "Ticket booth closes at 4pm.",
      "Phone: +1-530-555-0100",
      "Order at the counter.",
      "Confirmation #REPLACE-ME",
    ]) {
      expect(redactText(s).text, s).toBe(s);
    }
  });
  it("redacts every text file and drops manifest.trip_id; binaries untouched", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const r = redactBundle([
      { path: "manifest.json", data: enc(JSON.stringify({ trip_id: "7c31bd4b-a04f-4c94-b876-5bf298833fbf", places: [{ notes: "Confirmation #AB12CD" }] })) },
      { path: "index.html", data: enc("<p>Booking ref: HK44921</p>") },
      { path: "assets/x.png", data: png },
    ]);
    expect(r.count).toBe(2);
    const m = JSON.parse(dec(r.files[0].data));
    expect(m.trip_id).toBeNull();
    expect(m.places[0].notes).toBe("Confirmation #••••");
    expect(dec(r.files[1].data)).toBe("<p>Booking ref: ••••</p>");
    expect(r.files[2].data).toBe(png);
  });
});

describe("links and text", () => {
  const t = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
  it("accepts share links, remix links and bare tokens", () => {
    expect(tokenFrom(`https://waypackpreview.com/t/${t}/`)).toBe(t);
    expect(tokenFrom(`https://waypack.app/remix/${t}`)).toBe(t);
    expect(tokenFrom(` ${t} `)).toBe(t);
    expect(tokenFrom("https://waypack.app/account")).toBeNull();
  });
  it("turns a page into readable text for agents", () => {
    const text = htmlToText("<html><head><style>p{}</style></head><body><h2>Day 1</h2><p>Hike &amp; swim</p><script>var x=1</script><svg><text>logo</text></svg></body></html>");
    expect(text).toBe("Day 1\nHike & swim");
  });
});
