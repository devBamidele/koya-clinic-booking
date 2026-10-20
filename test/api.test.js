// End-to-end tests against a real (embedded) Postgres. Run: npm test
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { createPool, migrate } = require("../src/db");
const { createApp } = require("../src/app");

const KEY = "test-key";
const PORT = 54329;
let pg, pool, server, base;

before(async () => {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clinic-pg-"));
  pg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false, onLog: () => {} });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("clinic");
  pool = createPool(`postgres://postgres:pw@localhost:${PORT}/clinic`);
  pool.options.max = 30;
  await migrate(pool);
  await new Promise((r) => { server = createApp({ pool, apiKey: KEY }).listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  server && server.close();
  pool && (await pool.end());
  pg && (await pg.stop());
});

async function call(method, p, { body, key = KEY, headers = {} } = {}) {
  const h = { ...headers };
  if (key !== null) h["X-API-Key"] = key;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const res = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

const future = (h) => new Date(Date.now() + h * 36e5).toISOString().replace(/\.\d{3}Z$/, "Z");
const SLOTS = [
  { id: "s2", provider: "Dr Bello", start: future(48), end: future(48.5) },
  { id: "s1", provider: "Dr Ade", start: future(24), end: future(24.5) },
  { id: "s3", provider: "Dr Ade", start: future(72), end: future(72.5) },
  { id: "past", provider: "Dr Ade", start: "2020-01-01T09:00:00Z", end: "2020-01-01T09:30:00Z" },
];
let n = 0;
const uniqueEmail = () => `user${++n}@example.com`;
const reset = (slots = SLOTS) => call("POST", "/reset", { body: { slots } });
const book = (body, headers) => call("POST", "/bookings", { body, headers });

test("level 1: reset, list slots sorted, filter, book, get", async () => {
  assert.equal((await reset()).status, 200);
  const list = await call("GET", "/slots");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.slots.map((s) => s.id), ["past", "s1", "s2", "s3"]);
  assert.deepEqual(list.body.slots[1], { ...SLOTS[1], available: true });

  const ade = await call("GET", "/slots?provider=" + encodeURIComponent("Dr Ade"));
  assert.deepEqual(ade.body.slots.map((s) => s.id), ["past", "s1", "s3"]);

  const b = await book({ slot_id: "s1", name: "Ada Obi", email: "ada@example.com" });
  assert.equal(b.status, 201);
  assert.equal(b.body.status, "confirmed");
  assert.deepEqual(Object.keys(b.body).sort(), ["created_at", "email", "id", "name", "slot_id", "status"]);

  const got = await call("GET", `/bookings/${b.body.id}`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, b.body);
  assert.equal((await call("GET", "/bookings/nope")).status, 404);

  const after = await call("GET", "/slots");
  assert.equal(after.body.slots.find((s) => s.id === "s1").available, false);
});

test("level 2: api key and validation", async () => {
  await reset();
  for (const k of [null, "wrong"]) {
    for (const [m, p] of [["GET", "/slots"], ["POST", "/bookings"], ["GET", "/bookings/x"], ["POST", "/reset"]]) {
      const r = await call(m, p, { key: k, body: m === "POST" ? {} : undefined });
      assert.equal(r.status, 401, `${m} ${p} key=${k}`);
      assert.equal(typeof r.body.error, "string");
    }
  }
  const bad = [
    {}, { name: "A", email: uniqueEmail() }, { slot_id: "s1", email: uniqueEmail() },
    { slot_id: "s1", name: "A" }, { slot_id: "", name: "A", email: uniqueEmail() },
    { slot_id: "s1", name: "   ", email: uniqueEmail() }, { slot_id: "s1", name: "A", email: "not-an-email" },
    { slot_id: "s1", name: "A", email: "a@b" }, { slot_id: 5, name: "A", email: uniqueEmail() },
  ];
  for (const body of bad) assert.equal((await book(body)).status, 400, JSON.stringify(body));
  assert.equal((await book({ slot_id: "nope", name: "A", email: uniqueEmail() })).status, 404);
  assert.equal((await book({ slot_id: "past", name: "A", email: uniqueEmail() })).status, 400);

  const raw = await fetch(base + "/bookings", { method: "POST", headers: { "X-API-Key": KEY, "Content-Type": "application/json" }, body: "{bad" });
  assert.equal(raw.status, 400);

  const ok = await book({ slot_id: "s1", name: "  Ada Obi  ", email: "  ADA@Example.COM " });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.name, "Ada Obi");
  assert.equal(ok.body.email, "ada@example.com");
});

test("level 3: concurrent bookings for one slot, and cancellation", async () => {
  await reset();
  const results = await Promise.all(
    Array.from({ length: 25 }, () => book({ slot_id: "s2", name: "Racer", email: uniqueEmail() }))
  );
  const codes = results.map((r) => r.status).sort();
  assert.equal(codes.filter((c) => c === 201).length, 1, codes.join(","));
  assert.equal(codes.filter((c) => c === 409).length, 24);

  const winner = results.find((r) => r.status === 201).body;
  const del = await call("DELETE", `/bookings/${winner.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.status, "cancelled");
  assert.equal((await call("DELETE", `/bookings/${winner.id}`)).status, 409);
  assert.equal((await call("DELETE", "/bookings/nope")).status, 404);
  assert.equal((await call("GET", `/bookings/${winner.id}`)).body.status, "cancelled");
  assert.equal((await call("GET", "/slots")).body.slots.find((s) => s.id === "s2").available, true);
  assert.equal((await book({ slot_id: "s2", name: "Next", email: uniqueEmail() })).status, 201);
});

test("level 4: idempotency keys", async () => {
  await reset();
  const body = { slot_id: "s3", name: "Ada", email: uniqueEmail() };
  const h = { "Idempotency-Key": "retry-1" };
  const same = await Promise.all(Array.from({ length: 5 }, () => book(body, h)));
  assert.ok(same.every((r) => r.status === 201), same.map((r) => r.status).join());
  assert.equal(new Set(same.map((r) => r.body.id)).size, 1);
  const again = await book(body, h);
  assert.equal(again.status, 201);
  assert.equal(again.body.id, same[0].body.id);

  const list = await call("GET", `/bookings?email=${encodeURIComponent(body.email)}`);
  assert.equal(list.body.bookings.length, 1);

  assert.equal((await book({ ...body, name: "Someone else" }, h)).status, 422);

  // A failed response is replayed too.
  const fh = { "Idempotency-Key": "retry-2" };
  const f1 = await book({ slot_id: "s3", name: "B", email: uniqueEmail() }, fh);
  assert.equal(f1.status, 409);
  const f2 = await book({ slot_id: "s3", name: "B", email: `user${n}@example.com` }, fh);
  assert.equal(f2.status, 409);
});

test("level 4: paging through a person's bookings", async () => {
  const slots = Array.from({ length: 23 }, (_, i) => ({ id: `p${i}`, provider: "Dr Ade", start: future(10 + i), end: future(10.5 + i) }));
  await reset(slots);
  const emails = ["pager@example.com", "PAGER@example.com", "other@example.com"];
  // Book slowly enough to stay under the rate limit: reset clears it between batches.
  const ids = [];
  for (let i = 0; i < 23; i++) {
    if (i % 5 === 0 && i) await pool.query("TRUNCATE booking_attempts");
    const email = i % 4 === 3 ? emails[2] : emails[i % 2];
    const r = await book({ slot_id: `p${i}`, name: "P", email });
    assert.equal(r.status, 201);
    if (email !== emails[2]) ids.push(r.body.id);
  }
  let cursor = null, seen = [], pages = 0;
  do {
    const q = new URLSearchParams({ email: "Pager@Example.com", limit: "4" });
    if (cursor) q.set("cursor", cursor);
    const r = await call("GET", `/bookings?${q}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.bookings.length <= 4);
    seen.push(...r.body.bookings.map((b) => b.id));
    cursor = r.body.next_cursor;
    pages++;
  } while (cursor);
  assert.deepEqual(seen, ids);
  assert.equal(pages, Math.ceil(ids.length / 4));

  const def = await call("GET", "/bookings?email=pager@example.com");
  assert.equal(def.body.bookings.length, 10);
  for (const l of ["0", "51", "abc", "1.5", "-1", ""]) {
    assert.equal((await call("GET", `/bookings?email=pager@example.com&limit=${l}`)).status, 400, `limit=${l}`);
  }
  assert.equal((await call("GET", "/bookings?email=pager@example.com&cursor=garbage")).status, 400);
  assert.equal((await call("GET", "/bookings")).status, 400);
  const none = await call("GET", "/bookings?email=nobody@example.com");
  assert.deepEqual(none.body, { bookings: [], next_cursor: null });
});

test("level 5: rate limit per email", async () => {
  await reset();
  const email = "spammer@example.com";
  const results = await Promise.all(
    Array.from({ length: 8 }, () => book({ slot_id: "nope", name: "S", email }))
  );
  const codes = results.map((r) => r.status);
  assert.equal(codes.filter((c) => c === 404).length, 5, codes.join());
  const limited = results.filter((r) => r.status === 429);
  assert.equal(limited.length, 3);
  for (const r of limited) {
    const ra = r.headers.get("retry-after");
    assert.match(ra, /^\d+$/);
    assert.ok(Number(ra) >= 1 && Number(ra) <= 60);
    assert.equal(typeof r.body.error, "string");
  }
  assert.equal((await book({ slot_id: "s1", name: "S", email: " SPAMMER@example.com" })).status, 429);
  assert.equal((await book({ slot_id: "s1", name: "Other", email: uniqueEmail() })).status, 201);
});
