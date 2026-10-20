const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { HttpError } = require("./errors");
const { requireApiKey } = require("./middleware/apiKey");
const { errorHandler } = require("./middleware/errorHandler");
const { slotRoutes } = require("./routes/slots");
const { bookingRoutes } = require("./routes/bookings");

function createApp({ pool, apiKey }) {
  if (!apiKey) throw new Error("API_KEY must be set");
  const app = express();
  app.disable("x-powered-by");

  // Web page at "/", with the API key written in so it can call the API.
  const template = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const page = template.replace("__API_KEY__", JSON.stringify(apiKey).slice(1, -1));
  app.get("/", (_req, res) => res.type("html").send(page));
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  // The API, mounted at /api. CORS runs first so browser preflights pass.
  const api = express.Router();
  api.use(
    cors({
      allowedHeaders: ["Content-Type", "X-API-Key", "Idempotency-Key"],
      exposedHeaders: ["Retry-After"],
      methods: ["GET", "POST", "DELETE"],
    })
  );
  api.use(requireApiKey(apiKey));
  api.use(express.json({ limit: "100kb" }));
  api.use(slotRoutes(pool));
  api.use(bookingRoutes(pool));
  api.use((_req, _res, next) => next(new HttpError(404, "not found")));

  app.use("/api", api);
  app.use((_req, res) => res.status(404).json({ error: "not found" }));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
