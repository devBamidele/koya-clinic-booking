// Adds a week of demo slots the first time the app starts on an empty
// database, so the web page has something to show. POST /api/reset replaces them.
async function seedIfEmpty(pool) {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM slots");
  if (rows[0].n > 0) return;

  const providers = ["Dr Ade", "Dr Bello", "Dr Chukwu"];
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  let n = 0;
  for (let d = 1; d <= 7; d++) {
    for (const [p, provider] of providers.entries()) {
      for (const hour of [9 + p, 13 + p]) {
        const start = new Date(day.getTime() + d * 864e5 + hour * 36e5);
        const end = new Date(start.getTime() + 30 * 6e4);
        const iso = (t) => t.toISOString().replace(".000Z", "Z");
        n += 1;
        await pool.query(
          "INSERT INTO slots (id, provider, start_raw, end_raw, start_at, end_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
          [`s${n}`, provider, iso(start), iso(end), start, end]
        );
      }
    }
  }
}

module.exports = { seedIfEmpty };
