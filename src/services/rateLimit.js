const { fail } = require("../errors");

const MAX_ATTEMPTS = 5;
const WINDOW_SECONDS = 60;

// Level 5: counts this attempt for the email, or rejects with 429.
// Must run inside a transaction: the advisory lock serialises attempts for
// one email until commit, so the count is exact under concurrency.
async function checkRateLimit(client, email) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`rate:${email}`]);
  const { rows } = await client.query(
    `SELECT count(*)::int AS n,
            EXTRACT(EPOCH FROM (min(at) + make_interval(secs => $2) - clock_timestamp())) AS wait
       FROM booking_attempts
      WHERE email = $1 AND at > clock_timestamp() - make_interval(secs => $2)`,
    [email, WINDOW_SECONDS]
  );
  if (rows[0].n >= MAX_ATTEMPTS) {
    const retryAfter = Math.max(1, Math.ceil(Number(rows[0].wait)));
    fail(429, "too many booking attempts for this email, try again later", {
      "Retry-After": String(retryAfter),
    });
  }
  await client.query("INSERT INTO booking_attempts (email) VALUES ($1)", [email]);
}

module.exports = { checkRateLimit };
