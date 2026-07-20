// src/utils/AppError.js
// A custom error for expected, "safe to show the user" problems
// (bad input, not found, duplicate email, etc).
// Anything thrown that is NOT an AppError is treated as an unexpected
// bug, logged in full on the server, and shown to the user only as a
// generic "something went wrong" message.
class AppError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true; // marks this as a known, safe-to-display error
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;