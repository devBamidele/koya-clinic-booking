const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { withTransaction } = require("./db");

const RATE_LIMIT_MAX = 5;           // attempts per email...
const RATE_LIMIT_WINDOW_SECONDS = 60; // ...per this many seconds
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const fail = (status, message, headers) => {
  throw new HttpError(status, message, headers);
};

const isBlank = (v) => typeof v !== "string" || v.trim() === "";

// Stable JSON (sorted keys) so the same body always hashes the same.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function bookingJson(row) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
  };
}

const encodeCursor = (seq) => Buffer.from(JSON.stringify({ s: String(seq) })).toString("base64url");

function decodeCursor(cursor) {
  try {
    const { s } = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof s === "string" && /^\d{1,18}$/.test(s)) return s;
  } catch (_) {
    /* fall through */
  }
  return null;
}

// Wraps async handlers so thrown errors reach the error middleware.
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

// ---------- booking creation (levels 1-5) ----------

// Level 5: counts this attempt for the email, or rejects with 429.
// The advisory lock serialises attempts for one email so the count is exact.
async function checkRateLimit(client, email) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`rate:${email}`]);
  const { rows } = await client.query(
    `SELECT count(*)::int AS n,
            EXTRACT(EPOCH FROM (min(at) + make_interval(secs => $2) - clock_timestamp())) AS wait
       FROM booking_attempts
      WHERE email = $1 AND at > clock_timestamp() - make_interval(secs => $2)`,
    [email, RATE_LIMIT_WINDOW_SECONDS]
  );
  if (rows[0].n >= RATE_LIMIT_MAX) {
    const retryAfter = Math.max(1, Math.ceil(Number(rows[0].wait)));
    fail(429, "too many booking attempts for this email, try again later", {
      "Retry-After": String(retryAfter),
    });
  }
  await client.query("INSERT INTO booking_attempts (email) VALUES ($1)", [email]);
}

// Levels 1-3: validates and books. Returns { status, body }.
// Expected failures (400/404/409) are returned, not thrown, so the
// transaction still commits the rate-limit attempt and idempotency record.
async function bookSlot(client, body) {
  const { slot_id, name, email } = body;
  for (const [field, value] of Object.entries({ slot_id, name, email })) {
    if (isBlank(value)) return { status: 400, body: { error: `${field} is required` } };
  }
  const cleanName = name.trim();
  const cleanEmail = email.trim().toLowerCase();
  const slotId = slot_id.trim();
  if (cleanName.length > 200) return { status: 400, body: { error: "name is too long" } };
  if (cleanEmail.length > 254 || !EMAIL_RE.test(cleanEmail)) {
    return { status: 400, body: { error: "email is not valid" } };
  }

  // Lock the slot row: concurrent bookings for the same slot queue up here.
  const slot = await client.query(
    "SELECT id, start_at <= clock_timestamp() AS started FROM slots WHERE id = $1 FOR UPDATE",
    [slotId]
  );
  if (slot.rowCount === 0) return { status: 404, body: { error: "slot not found" } };
  if (slot.rows[0].started) return { status: 400, body: { error: "slot has already started" } };

  const taken = await client.query(
    "SELECT 1 FROM bookings WHERE slot_id = $1 AND status = 'confirmed'",
    [slotId]
  );
  if (taken.rowCount > 0) return { status: 409, body: { error: "slot is already booked" } };

  // The unique index is a second line of defence; the savepoint keeps the
  // transaction usable if it ever fires.
  await client.query("SAVEPOINT book");
  try {
    const { rows } = await client.query(
      `INSERT INTO bookings (id, slot_id, name, email, status, created_at)
       VALUES ($1, $2, $3, $4, 'confirmed', $5) RETURNING *`,
      [`bk_${crypto.randomUUID()}`, slotId, cleanName, cleanEmail, new Date()]
    );
    return { status: 201, body: bookingJson(rows[0]) };
  } catch (err) {
    if (err.code === "23505") {
      await client.query("ROLLBACK TO SAVEPOINT book");
      return { status: 409, body: { error: "slot is already booked" } };
    }
    throw err;
  }
}

async function createBooking(pool, body, idempotencyKey) {
  const requestHash = sha256(canonical(body));
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  return withTransaction(pool, async (client) => {
    // Level 4: claim the key. If another request holds it, Postgres makes us
    // wait until that request commits, then we replay its stored response.
    if (idempotencyKey) {
      const claim = await client.query(
        `INSERT INTO idempotency_keys (key, request_hash, status_code, response_body)
         VALUES ($1, $2, 0, '{}') ON CONFLICT (key) DO NOTHING`,
        [idempotencyKey, requestHash]
      );
      if (claim.rowCount === 0) {
        const { rows } = await client.query(
          "SELECT request_hash, status_code, response_body FROM idempotency_keys WHERE key = $1",
          [idempotencyKey]
        );
        if (rows[0].request_hash !== requestHash) {
          return { status: 422, body: { error: "Idempotency-Key was already used with a different request body" } };
        }
        return { status: rows[0].status_code, body: rows[0].response_body };
      }
    }

    // Level 5: a 429 throws, which rolls back the claimed key too, so the
    // client can retry with the same key once the window passes.
    if (email) await checkRateLimit(client, email);

    const result = await bookSlot(client, body);

    if (idempotencyKey) {
      await client.query(
        "UPDATE idempotency_keys SET status_code = $2, response_body = $3 WHERE key = $1",
        [idempotencyKey, result.status, result.body]
      );
    }
    return result;
  });
}

// ---------- app ----------

function createApp({ pool, apiKey }) {
  if (!apiKey) throw new Error("API_KEY must be set");
  const app = express();
  app.disable("x-powered-by");

  // Web page (no key needed to load the page itself).
  const pageTemplate = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const page = pageTemplate.replace("__API_KEY__", JSON.stringify(apiKey).slice(1, -1));
  app.get("/", (_req, res) => res.type("html").send(page));
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  // ---------- API, mounted at /api ----------
  const api = express.Router();

  api.use(
    cors({
      allowedHeaders: ["Content-Type", "X-API-Key", "Idempotency-Key"],
      exposedHeaders: ["Retry-After"],
      methods: ["GET", "POST", "DELETE"],
    })
  );

  // Level 2: every API request needs the key. Constant-time comparison.
  const expected = Buffer.from(sha256(apiKey));
  api.use((req, _res, next) => {
    const given = req.get("X-API-Key");
    if (!given || !crypto.timingSafeEqual(Buffer.from(sha256(given)), expected)) {
      return next(new HttpError(401, "missing or invalid API key"));
    }
    next();
  });

  api.use(express.json({ limit: "100kb" }));

  // Level 1: replace all slots and delete all bookings.
  api.post(
    "/reset",
    route(async (req, res) => {
      const slots = req.body && req.body.slots;
      if (!Array.isArray(slots)) fail(400, "slots must be an array");
      const seen = new Set();
      const rows = slots.map((s, i) => {
        if (!s || typeof s !== "object") fail(400, `slots[${i}] must be an object`);
        for (const f of ["id", "provider", "start", "end"]) {
          if (isBlank(s[f])) fail(400, `slots[${i}].${f} is required`);
        }
        const start = new Date(s.start);
        const end = new Date(s.end);
        if (isNaN(start) || isNaN(end)) fail(400, `slots[${i}] has an invalid start or end`);
        if (seen.has(s.id)) fail(400, `duplicate slot id ${s.id}`);
        seen.add(s.id);
        return [s.id, s.provider, s.start, s.end, start, end];
      });

      await withTransaction(pool, async (client) => {
        await client.query("TRUNCATE bookings, slots, idempotency_keys, booking_attempts RESTART IDENTITY");
        for (const r of rows) {
          await client.query(
            "INSERT INTO slots (id, provider, start_raw, end_raw, start_at, end_at) VALUES ($1,$2,$3,$4,$5,$6)",
            r
          );
        }
      });
      res.json({ status: "ok", slots: rows.length });
    })
  );

  // Level 1: list slots, earliest first, optional exact provider filter.
  api.get(
    "/slots",
    route(async (req, res) => {
      const provider = typeof req.query.provider === "string" ? req.query.provider : null;
      const { rows } = await pool.query(
        `SELECT s.id, s.provider, s.start_raw, s.end_raw,
                NOT EXISTS (SELECT 1 FROM bookings b
                             WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
           FROM slots s
          WHERE $1::text IS NULL OR s.provider = $1
          ORDER BY s.start_at, s.id`,
        [provider]
      );
      res.json({
        slots: rows.map((r) => ({
          id: r.id,
          provider: r.provider,
          start: r.start_raw,
          end: r.end_raw,
          available: r.available,
        })),
      });
    })
  );

  // Levels 1-5: book a slot.
  api.post(
    "/bookings",
    route(async (req, res) => {
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      const key = req.get("Idempotency-Key");
      const result = await createBooking(pool, body, key && key.trim() ? key : null);
      res.status(result.status).json(result.body);
    })
  );

  // Level 4: a person's bookings, oldest first, cursor pagination.
  api.get(
    "/bookings",
    route(async (req, res) => {
      const { email, limit: rawLimit, cursor } = req.query;
      if (isBlank(email)) fail(400, "email is required");

      let limit = 10;
      if (rawLimit !== undefined) {
        if (typeof rawLimit !== "string" || !/^\d+$/.test(rawLimit)) fail(400, "limit must be an integer from 1 to 50");
        limit = Number(rawLimit);
        if (limit < 1 || limit > 50) fail(400, "limit must be an integer from 1 to 50");
      }

      let after = "0";
      if (cursor !== undefined && cursor !== "") {
        after = typeof cursor === "string" ? decodeCursor(cursor) : null;
        if (after === null) fail(400, "cursor is not valid");
      }

      const { rows } = await pool.query(
        `SELECT * FROM bookings WHERE email = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
        [email.trim().toLowerCase(), after, limit + 1]
      );
      const page = rows.slice(0, limit);
      res.json({
        bookings: page.map(bookingJson),
        next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1].seq) : null,
      });
    })
  );

  // Level 1: get one booking.
  api.get(
    "/bookings/:id",
    route(async (req, res) => {
      const { rows } = await pool.query("SELECT * FROM bookings WHERE id = $1", [req.params.id]);
      if (rows.length === 0) fail(404, "booking not found");
      res.json(bookingJson(rows[0]));
    })
  );

  // Level 3: cancel a booking, which frees its slot.
  api.delete(
    "/bookings/:id",
    route(async (req, res) => {
      const { rows } = await pool.query(
        "UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed' RETURNING *",
        [req.params.id]
      );
      if (rows.length > 0) return res.json(bookingJson(rows[0]));
      const exists = await pool.query("SELECT 1 FROM bookings WHERE id = $1", [req.params.id]);
      if (exists.rowCount === 0) fail(404, "booking not found");
      fail(409, "booking is already cancelled");
    })
  );

  api.use((_req, _res, next) => next(new HttpError(404, "not found")));
  app.use("/api", api);
  app.use((_req, res) => res.status(404).json({ error: "not found" }));

  // Every error becomes {"error": "..."}.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) {
      res.set(err.headers).status(err.status).json({ error: err.message });
    } else if (err.type === "entity.parse.failed") {
      res.status(400).json({ error: "request body is not valid JSON" });
    } else if (err.type === "entity.too.large") {
      res.status(413).json({ error: "request body is too large" });
    } else {
      console.error(err);
      res.status(500).json({ error: "internal server error" });
    }
  });

  return app;
}

module.exports = { createApp };
