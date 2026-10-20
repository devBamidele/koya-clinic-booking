const crypto = require("crypto");
const { withTransaction } = require("../db");
const { isBlank, normalizeEmail, sha256, canonical } = require("../utils");
const { bookingJson } = require("../serializers");
const { checkRateLimit } = require("./rateLimit");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Levels 1-3: validates and books. Returns { status, body }.
// Expected failures (400/404/409) are returned, not thrown, so the
// transaction still commits the rate-limit attempt and idempotency record.
async function bookSlot(client, body) {
  const { slot_id, name, email } = body;
  for (const [field, value] of Object.entries({ slot_id, name, email })) {
    if (isBlank(value)) return { status: 400, body: { error: `${field} is required` } };
  }
  const cleanName = name.trim();
  const cleanEmail = normalizeEmail(email);
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

// Level 4: claims the key. Returns a stored response to replay, or null if
// this request now owns the key. If another request holds it, Postgres makes
// us wait until that request commits.
async function claimIdempotencyKey(client, key, requestHash) {
  const claim = await client.query(
    `INSERT INTO idempotency_keys (key, request_hash, status_code, response_body)
     VALUES ($1, $2, 0, '{}') ON CONFLICT (key) DO NOTHING`,
    [key, requestHash]
  );
  if (claim.rowCount === 1) return null;

  const { rows } = await client.query(
    "SELECT request_hash, status_code, response_body FROM idempotency_keys WHERE key = $1",
    [key]
  );
  if (rows[0].request_hash !== requestHash) {
    return { status: 422, body: { error: "Idempotency-Key was already used with a different request body" } };
  }
  return { status: rows[0].status_code, body: rows[0].response_body };
}

// Levels 1-5: the whole booking flow in one transaction.
async function createBooking(pool, body, idempotencyKey) {
  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";

  return withTransaction(pool, async (client) => {
    if (idempotencyKey) {
      const replay = await claimIdempotencyKey(client, idempotencyKey, sha256(canonical(body)));
      if (replay) return replay;
    }

    // A 429 throws, which rolls back the claimed key too, so the client can
    // retry with the same key once the window passes.
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

module.exports = { createBooking };
