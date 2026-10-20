// Shapes database rows into the JSON the spec describes.

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

function slotJson(row) {
  return {
    id: row.id,
    provider: row.provider,
    start: row.start_raw,
    end: row.end_raw,
    available: row.available,
  };
}

// Cursors are opaque to clients: base64url of the last booking's position.
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

module.exports = { bookingJson, slotJson, encodeCursor, decodeCursor };
