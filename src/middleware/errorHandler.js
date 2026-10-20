const { HttpError } = require("../errors");

// Every error becomes {"error": "..."}.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, _req, res, _next) {
  if (err instanceof HttpError) {
    res.set(err.headers).status(err.status).json({ error: err.message });
  } else if (err.type === "entity.parse.failed") {
    res.status(400).json({ error: "request body is not valid JSON" });
  } else if (err.type === "entity.too.large") {
    res.status(413).json({ error: "request body is too large" });
  } else {
    console.error(err);
    res.status(500).json({ error: "internal server error" });
  }
}

module.exports = { errorHandler };
