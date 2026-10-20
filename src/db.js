const { Pool } = require("pg");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS slots (
  id        text PRIMARY KEY,
  provider  text NOT NULL,
  start_raw text NOT NULL,          -- returned exactly as it was sent
  end_raw   text NOT NULL,
  start_at  timestamptz NOT NULL,   -- used for ordering and "already started"
  end_at    timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  seq        bigserial PRIMARY KEY, -- insertion order, used for cursors
  id         text NOT NULL UNIQUE,
  slot_id    text NOT NULL,
  name       text NOT NULL,
  email      text NOT NULL,
  status     text NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at timestamptz NOT NULL
);

-- The database itself guarantees a slot has at most one confirmed booking.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_confirmed_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS bookings_email_seq ON bookings (email, seq);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           text PRIMARY KEY,
  request_hash  text NOT NULL,
  status_code   integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS booking_attempts (
  id    bigserial PRIMARY KEY,
  email text NOT NULL,
  at    timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS booking_attempts_email_at ON booking_attempts (email, at);
`;

function createPool(connectionString) {
  const needsSsl = !/localhost|127\.0\.0\.1/.test(connectionString);
  return new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX || 10),
    ssl: needsSsl ? { rejectUnauthorized: false } : false,
  });
}

async function migrate(pool) {
  await pool.query(SCHEMA);
}

// Runs fn inside a transaction and always releases the connection.
async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createPool, migrate, withTransaction };
