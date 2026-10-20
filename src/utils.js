const crypto = require("crypto");

const isBlank = (v) => typeof v !== "string" || v.trim() === "";

const normalizeEmail = (email) => email.trim().toLowerCase();

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// Stable JSON (sorted keys) so the same body always hashes the same.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// Wraps async handlers so thrown errors reach the error middleware.
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

module.exports = { isBlank, normalizeEmail, sha256, canonical, route };
