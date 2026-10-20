const crypto = require("crypto");
const { HttpError } = require("../errors");
const { sha256 } = require("../utils");

// Level 2: every API request needs the key. Hashing both sides gives equal
// lengths, so timingSafeEqual can compare them in constant time.
function requireApiKey(apiKey) {
  const expected = Buffer.from(sha256(apiKey));
  return (req, _res, next) => {
    const given = req.get("X-API-Key");
    if (!given || !crypto.timingSafeEqual(Buffer.from(sha256(given)), expected)) {
      return next(new HttpError(401, "missing or invalid API key"));
    }
    next();
  };
}

module.exports = { requireApiKey };
