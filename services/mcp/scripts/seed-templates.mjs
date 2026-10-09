// Fills a LOCAL dev gallery with sample templates (for working on Discover in the site and app).
//   node scripts/seed-templates.mjs [--url http://127.0.0.1:8787]
// Creates past trips for gallery@waypack.test straight in the local database, then turns each into a
// template through the real MCP tools (draft_template → publish_template). Local stack only.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const BASE = args.includes("--url") ? args[args.indexOf("--url") + 1] : process.env.WAYPACK_URL ?? "http://127.0.0.1:8787";
const SUPA = process.env.SUPABASE_URL ?? "http://127.0.0.1:55421";
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(SUPA)) throw new Error("seed-templates is for the local stack only");
const env = Object.fromEntries(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const svc = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" };

// [title, region, lat, lon, start, days, crew, pace, move, preset/scene, accent, tags, plan, kept, cut, surprise, recheck, from, author, remixes, months]
const SAMPLES = [
  ["Sequoia in the snow", "California, USA", 36.56, -118.75, "2026-01-16", 3, { adults: 2, kids: [9, 6] }, "easy", "car", { preset: "winter-forest" }, "#3F6EA8", ["Snow", "Big trees", "Kids"],
    [["Foothills to Giant Forest", ["Chain check at Hospital Rock", "General Sherman Tree", "Big Trees Trail (flat, 1.3 mi)", "Wuksachi Lodge"]], ["Snowshoes and sledding", ["Ranger snowshoe walk, 10:00", "Lunch at the lodge", "Wolverton sledding hill", "Hot chocolate and stars"]], ["Grant Grove and home", ["General Grant Tree", "Grant Grove village", "Kings Canyon overlook", "Drive home before dark"]]],
    ["The ranger snowshoe walk was the highlight. Sign up at the Giant Forest Museum by 9:30; snowshoes are free."], ["Moro Rock: the stairs were iced over and closed.", "Crystal Cave is shut all winter, don't plan for it."], ["Chains were required from Hospital Rock up. Rent them in Three Rivers, not at the gate.", "No cell signal above 5,000 ft. Download everything first."],
    ["Road and chain controls on the Generals Highway", "Snowshoe walk days", "Lodge dates and rates"], "4 h from the SF Bay Area", "Mia", 128, [12, 1, 2, 3]],
  ["Kyoto in autumn, kid pace", "Kyoto, Japan", 35.0, 135.77, "2025-11-14", 6, { adults: 2, kids: [9, 6] }, "easy", "transit", { preset: "autumn" }, "#C2562D", ["Fall colours", "Temples", "Kids", "No car"],
    [["Arrive, Gion at dusk", ["Haruka from Kansai Airport", "Check in near Shijo", "Gion and Shirakawa walk", "Nishiki Market dinner"]], ["Fushimi Inari early", ["Fushimi Inari gates at 7:30", "Tofuku-ji maple bridge", "Nap break", "Kamo River stepping stones"]], ["Nara deer day", ["Kintetsu to Nara", "Nara Park deer", "Todai-ji Great Buddha", "Back by 16:00"]], ["Arashiyama", ["Bamboo grove at 8:00", "Monkey Park Iwatayama", "Hozu river boat", "Okochi Sanso tea"]], ["Higashiyama", ["Kiyomizu-dera at opening", "Sannenzaka", "Maruyama Park"]], ["Home", ["Kyoto Station", "Haruka to the airport"]]],
    ["Being at every big sight in the first hour it opened. By 10 the crowds made it miserable with kids."], ["Kinkaku-ji: far, packed, and the kids lasted 15 minutes."], ["Monkey Park was the kids' favourite thing all week.", "Taxis for four cost about the same as the bus and the buses were full."],
    ["Peak foliage dates this year", "Temple hours and night illuminations", "Rail pass prices"], "Fly into Kansai (KIX)", null, 342, [10, 11, 12]],
  ["Lisbon & Sintra long weekend", "Lisbon, Portugal", 38.72, -9.14, "2026-03-06", 4, { adults: 2, kids: [] }, "moderate", "transit", { preset: "city" }, "#2F7F9E", ["City", "Food", "Couple", "No car"],
    [["Alfama and the castle", ["Tram 28 from Martim Moniz", "Castelo de São Jorge", "Miradouro de Santa Luzia", "Fado in Alfama"]], ["Sintra day", ["Train from Rossio, 8:11", "Pena Palace (timed entry)", "Quinta da Regaleira well", "Travesseiros at Piriquita"]], ["Belém", ["Jerónimos Monastery", "Pastéis de Belém", "MAAT riverside walk", "LX Factory dinner"]], ["Last morning", ["Time Out Market", "Airport metro"]]],
    ["Pena Palace on the first timed slot, then walking down to Regaleira (all downhill)."], ["Tram 28: the queue was an hour. We walked the route instead."], ["Every street is a hill and the cobbles are slippery in rain. Bring real shoes."],
    ["Pena Palace timed tickets", "Fado house booking", "Train times to Sintra"], null, "Jo & Sam", 211, [3, 4, 5, 9, 10]],
  ["Zion without the permits", "Utah, USA", 37.25, -112.95, "2026-04-10", 3, { adults: 2, kids: [] }, "moderate", "mixed", { preset: "desert" }, "#C0582E", ["Hiking", "Desert", "Couple"],
    [["Arrive, Watchman at sunset", ["Springdale check-in", "Pa'rus Trail", "Watchman Trail", "Canyon Junction bridge"]], ["Main canyon by shuttle", ["First shuttle, 6:00", "Scout Lookout", "Riverside Walk", "Emerald Pools"]], ["Kolob and out", ["Kolob Canyons Road", "Timber Creek Overlook", "Drive out by noon"]]],
    ["Scout Lookout gives you most of the Angels Landing view without the permit."], ["The Narrows were closed for snowmelt all week. Spring often does this."], ["The 8:00 shuttle line was a 45-minute wait. At 6:00 there was none."],
    ["Narrows flow rate and closures", "Shuttle season and first bus"], "2.5 h from Las Vegas", null, 96, [3, 4, 5, 10, 11]],
  ["Olympic Peninsula loop with a dog", "Washington, USA", 47.8, -123.9, "2025-08-08", 5, { adults: 2, kids: [10], pets: 1 }, "easy", "car", { preset: "lake-summer", scene: { water: "ocean" } }, "#4E7D4F", ["Dog friendly", "Beaches", "Rainforest"],
    [["Port Angeles", ["Ferry from Edmonds", "Hurricane Ridge viewpoint", "Lake Crescent swim"]], ["Rialto and Hoh", ["Rialto Beach (dogs OK to Ellen Creek)", "Hoh Rain Forest", "Forks dinner"]], ["Ruby and Kalaloch", ["Ruby Beach tide pools", "Kalaloch Tree of Life", "Lodge cabin"]], ["Quinault", ["Quinault Lake loop road", "World's largest spruce"]], ["Home", ["Aberdeen", "Seattle"]]],
    ["Planning each beach around low tide. The tide pools at Ruby Beach were the trip."], ["Sol Duc Falls: no dogs on the trail, so one of us waited in the car."], ["Dogs are banned on almost every park trail but welcome on most beaches."],
    ["Tide tables for your dates", "Pet rules by beach"], "From Seattle", "the Parks", 74, [6, 7, 8, 9]],
  ["Maui slow week", "Hawaii, USA", 20.8, -156.4, "2026-04-03", 8, { adults: 2, kids: [8, 5] }, "easy", "car", { preset: "tropical" }, "#E0703A", ["Beach", "Snorkel", "Kids"],
    [["Arrive, Kihei", ["Kahului airport", "Groceries", "Kamaole III sunset"]], ["Haleakalā sunrise", ["Leave 3:00 (reservation)", "Summit sunrise", "Kula breakfast", "Nap"]], ["Snorkel Napili", ["Napili Bay turtles", "Honolua lookout", "Shave ice"]], ["Beach day", ["Baby Beach", "Paia lunch"]], ["Twin Falls", ["Twin Falls", "Hookipa turtles"]], ["Slow day", ["Pool", "Kihei tacos"]], ["Iao Valley", ["Iao Needle", "Wailuku"]], ["Home", ["Kahului"]]],
    ["One early day, then nothing before 9 for the rest of the week. The kids were happy."], ["The full Road to Hana: too long with a 5-year-old. Twin Falls was enough."], ["Sunrise at the summit is near freezing. Bring hats and blankets."],
    ["Haleakalā sunrise reservation", "Snorkel conditions"], null, null, 188, [4, 5, 6, 9, 10]],
  ["Iceland south coast", "South Iceland", 63.6, -19.5, "2025-09-12", 6, { adults: 4, kids: [] }, "moderate", "car", { preset: "alpine-winter", scene: { water: "ocean", trees: "none", ground: "rock" } }, "#3E7A8C", ["Road trip", "Waterfalls", "Friends"],
    [["Golden Circle", ["Þingvellir", "Geysir", "Gullfoss", "Secret Lagoon"]], ["Waterfalls", ["Seljalandsfoss", "Skógafoss", "Kvernufoss", "Vík"]], ["Black sand", ["Reynisfjara", "Dyrhólaey", "Fjaðrárgljúfur"]], ["Glacier lagoon", ["Jökulsárlón", "Diamond Beach", "Höfn"]], ["West again", ["Skaftafell", "Svartifoss"]], ["Back to Reykjavík", ["Kerið crater", "Reykjavík"]]],
    ["Sleeping in Vík and Höfn so the long drives were split in two."], ["The plane wreck walk: two hours there and back for a photo."], ["Wind closed the road for half a day. Keep a spare afternoon."],
    ["Road and wind warnings", "Glacier hike operators"], "From Keflavík airport", "Ana", 402, [6, 7, 8, 9]],
  ["Smokies car camping", "Tennessee, USA", 35.65, -83.55, "2025-07-03", 4, { adults: 2, kids: [7, 4], pets: 1 }, "easy", "car", { preset: "lake-summer", scene: { water: "river", mountains: "rolling" } }, "#4E7D4F", ["Camping", "Creeks", "Kids", "Dog friendly"],
    [["Set up at Elkmont", ["Elkmont campground", "Little River swim", "Campfire"]], ["Waterfalls", ["Laurel Falls (paved)", "Cades Cove loop", "Abrams Creek"]], ["Gatlinburg treat day", ["Gatlinburg Trail (dogs OK)", "Pancakes", "Rainy-day backup: aquarium"]], ["Pack up", ["Sugarlands visitor center"]]],
    ["Elkmont as the base: the river is right there and the kids swam every afternoon."], ["Clingmans Dome: fogged in, and the walk up was steep for the 4-year-old."], ["Parking tags are required at every stop now. Buy them before you arrive."],
    ["Parking tag rules", "Campground reservations"], null, null, 63, [5, 6, 7, 9, 10]],
  ["Tahoe first ski weekend", "California, USA", 39.17, -120.14, "2026-02-13", 4, { adults: 2, kids: [9, 6] }, "moderate", "car", { preset: "alpine-winter" }, "#3F6EA8", ["Ski", "Snow", "Kids"],
    [["Drive up Friday", ["Leave by 11 to beat the traffic", "Rentals in Truckee", "Check in"]], ["Lesson day", ["Kids' ski school 8:30", "Parents' blue run", "Pick up 15:00", "Hot tub"]], ["Snow play", ["Sledding at Tahoe City", "Emerald Bay lookout", "Pizza"]], ["Home", ["Leave before 9"]]],
    ["Renting in Truckee the night before. No line at the mountain in the morning."], ["A second ski day. Everyone was tired, so we went sledding instead."], ["Sunday's drive home took six hours. Leave Monday or before 9."],
    ["Chain controls on I-80", "Ski school availability", "Lift ticket prices"], "3.5 h from the SF Bay Area", null, 151, [12, 1, 2, 3]],
];

const day = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const signin = await fetch(`${BASE}/api/auth/dev`, { method: "POST", headers: { "Content-Type": "application/json", "X-Waypack": "1" }, body: JSON.stringify({ email: "gallery@waypack.test" }) });
if (!signin.ok) throw new Error(`dev sign-in failed (${signin.status}) — is wrangler dev running on ${BASE}?`);
const sess = await signin.json();
const pat = await (await fetch(`${BASE}/api/tokens`, { method: "POST", headers: { Authorization: `Bearer ${sess.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ label: "seed-templates" }) })).json();
const call = async (name, a) => {
  const r = await (await fetch(`${BASE}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${pat.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: a } }) })).json();
  if (r.result?.isError) throw new Error(`${name}: ${r.result.content[0].text}`);
  return r.result;
};
const rest = async (method, path, body) => {
  const r = await fetch(`${SUPA}/rest/v1/${path}`, { method, headers: svc, body: body && JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
};
// Start clean: this account's earlier seed.
await rest("DELETE", `trips?user_id=eq.${sess.userId}`);

for (const [title, region, lat, lon, start, days, crew, pace, move, theme, accent, tags, plan, kept, cut, surprise, recheck, from, author, remixes, months] of SAMPLES) {
  let n = 0;
  const places = [], dayList = [];
  plan.forEach(([dt, stops], di) => {
    dayList.push({ date: day(start, di), title: dt, items: stops.map((s) => { const id = `p${n++}`; const a = n * 2.4; places.push({ id, name: s, category: "sight", lat: +(lat + Math.sin(a) * 0.04 * (1 + di * 0.6)).toFixed(5), lon: +(lon + Math.cos(a) * 0.05 * (1 + di * 0.6)).toFixed(5) }); return { title: s, place_id: id, kind: "activity" }; }) });
  });
  const manifest = {
    schema_version: 1, sdk_version: "1", title, summary: kept[0], timezone: "UTC", start_date: start, end_date: day(start, days - 1),
    travelers: { adults: crew.adults, children: crew.kids.map((age) => ({ age })), pets: crew.pets ? [{ kind: "dog" }] : [] },
    theme: { ...theme, accent }, map: { bbox: [lon - 0.3, lat - 0.3, lon + 0.3, lat + 0.3] }, places, routes: [], days: dayList,
  };
  const [trip] = await rest("POST", "trips", { user_id: sess.userId, title, start_date: start, end_date: manifest.end_date, current_version: 1, status: "ready" });
  await rest("POST", "trip_versions", { trip_id: trip.id, version: 1, bundle_key: `seed/${trip.id}.zip`, bundle_sha256: "0".repeat(64), bundle_bytes: 1, manifest, sdk_version: "1" });
  const d = await call("draft_template", { trip_id: trip.id, tagline: kept[0].split(".")[0] + ".", region, notes: { kept, cut, surprise }, recheck, tags, pace, getting_around: move, good_months: months, starts_from: from ?? undefined, author_name: author ?? undefined });
  const id = d.structuredContent.template_id;
  await call("publish_template", { template_id: id });
  await rest("PATCH", `trip_templates?id=eq.${id}`, { remix_count: remixes });
  console.log(`✓ ${title} → ${d.structuredContent.url}`);
}
console.log(`Gallery: ${BASE}/discover`);
