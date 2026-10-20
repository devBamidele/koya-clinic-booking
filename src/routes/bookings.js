const express = require("express");
const { fail } = require("../errors");
const { isBlank, normalizeEmail, route } = require("../utils");
const { bookingJson, encodeCursor, decodeCursor } = require("../serializers");
const { createBooking } = require("../services/bookings");

function parseLimit(raw) {
  if (raw === undefined) return 10;
  const limit = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(limit >= 1 && limit <= 50)) fail(400, "limit must be an integer from 1 to 50");
  return limit;
}

function parseCursor(raw) {
  if (raw === undefined || raw === "") return "0";
  const after = typeof raw === "string" ? decodeCursor(raw) : null;
  if (after === null) fail(400, "cursor is not valid");
  return after;
}

function bookingRoutes(pool) {
  const router = express.Router();

  // Levels 1-5: book a slot.
  router.post(
    "/bookings",
    route(async (req, res) => {
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      const key = req.get("Idempotency-Key");
      const result = await createBooking(pool, body, key && key.trim() ? key : null);
      res.status(result.status).json(result.body);
    })
  );

  // Level 4: a person's bookings, oldest first, cursor pagination.
  router.get(
    "/bookings",
    route(async (req, res) => {
      const { email } = req.query;
      if (isBlank(email)) fail(400, "email is required");
      const limit = parseLimit(req.query.limit);
      const after = parseCursor(req.query.cursor);

      // Fetch one extra row to know whether another page exists.
      const { rows } = await pool.query(
        "SELECT * FROM bookings WHERE email = $1 AND seq > $2 ORDER BY seq LIMIT $3",
        [normalizeEmail(email), after, limit + 1]
      );
      const page = rows.slice(0, limit);
      res.json({
        bookings: page.map(bookingJson),
        next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1].seq) : null,
      });
    })
  );

  // Level 1: get one booking.
  router.get(
    "/bookings/:id",
    route(async (req, res) => {
      const { rows } = await pool.query("SELECT * FROM bookings WHERE id = $1", [req.params.id]);
      if (rows.length === 0) fail(404, "booking not found");
      res.json(bookingJson(rows[0]));
    })
  );

  // Level 3: cancel a booking, which frees its slot.
  router.delete(
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

  return router;
}

module.exports = { bookingRoutes };
