const jwt = require('jsonwebtoken');

const GUEST_USER_ID = 1; // Default guest user — login disabled for now

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    // No token — use guest user
    req.userId = GUEST_USER_ID;
    return next();
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch {
    // Invalid token — fall back to guest
    req.userId = GUEST_USER_ID;
    next();
  }
}

module.exports = authMiddleware;
