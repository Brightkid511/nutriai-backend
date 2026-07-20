// src/middleware/errorHandler.js
// Central error handler. Registered LAST in index.js, after all routes.
// - Logs the FULL error (with stack trace) to the server console for you.
// - Sends the CLIENT only a safe, generic message unless it's a known
//   AppError we explicitly marked as safe to display.

const notFoundHandler = (req, res, next) => {
  res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.originalUrl}`,
  });
};

const errorHandler = (err, req, res, next) => {
  // Full detail goes to your server logs only - never to the client.
  console.error('❌ ERROR:', err);

  // Errors we deliberately threw ourselves (validation, "not found", etc.)
  // are safe to show as-is.
  if (err.isOperational) {
    return res.status(err.statusCode || 400).json({
      success: false,
      error: err.message,
    });
  }

  // MySQL duplicate entry (e.g. unique email constraint)
  if (err.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({
      success: false,
      error: 'This record already exists.',
    });
  }

  // JSON body parse errors from express.json()
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      success: false,
      error: 'Invalid request format.',
    });
  }

  // Anything else = an unexpected bug. Never leak err.message here -
  // it can contain SQL, file paths, or library internals.
  return res.status(500).json({
    success: false,
    error: 'Something went wrong on our end. Please try again shortly.',
  });
};

module.exports = { errorHandler, notFoundHandler };