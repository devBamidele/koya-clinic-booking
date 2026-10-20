const express = require("express");
const { withTransaction } = require("../db");
const { fail } = require("../errors");
const { isBlank, route } = require("../utils");
const { slotJson } = require("../serializers");

function parseSlots(slots) {
  if (!Array.isArray(slots)) fail(400, "slots must be an array");
  const seen = new Set();
  return slots.map((s, i) => {
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
}

function slotRoutes(pool) {
  const router = express.Router();

  // Level 1: replace all slots and delete all bookings. Also clears
  // idempotency keys and rate-limit counters so every run starts clean.
  router.post(
    "/reset",
    route(async (req, res) => {
      const rows = parseSlots(req.body && req.body.slots);
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
  router.get(
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
      res.json({ slots: rows.map(slotJson) });
    })
  );

  return router;
}

module.exports = { slotRoutes };
