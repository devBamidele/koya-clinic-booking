// An error that becomes an HTTP response: {"error": message}.
class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const fail = (status, message, headers) => {
  throw new HttpError(status, message, headers);
};

module.exports = { HttpError, fail };
