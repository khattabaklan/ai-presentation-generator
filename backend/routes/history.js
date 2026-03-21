const express = require('express');
const pool = require('../config/db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

router.get('/', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, slide_count, color_theme, status, created_at FROM generations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.userId]
    );

    res.json({ generations: result.rows });
  } catch (err) {
    console.error('History error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
