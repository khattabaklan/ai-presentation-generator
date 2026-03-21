const express = require('express');
const pool = require('../config/db');
const authMiddleware = require('../middleware/auth');
const { generateLimiter } = require('../middleware/rateLimit');
const { generatePresentationContent } = require('../services/claude');
const { generatePptxBuffer } = require('../services/slideBuilder');
const { generateDocxBuffer } = require('../services/scriptBuilder');

const router = express.Router();

router.post('/', authMiddleware, generateLimiter, async (req, res) => {
  try {
    const { assignmentText, slideCount = 10, colorTheme = 'professional' } = req.body;

    if (!assignmentText || assignmentText.trim().length === 0) {
      return res.status(400).json({ error: 'Assignment text is required' });
    }

    if (assignmentText.length > 10000) {
      return res.status(400).json({ error: 'Assignment text must be under 10,000 characters' });
    }

    const slides = Math.min(Math.max(parseInt(slideCount) || 10, 5), 20);

    // Check access
    const userResult = await pool.query(
      'SELECT subscription_status, free_generations_used FROM users WHERE id = $1',
      [req.userId]
    );
    const user = userResult.rows[0];

    if (user.subscription_status === 'free' && user.free_generations_used >= 1) {
      return res.status(402).json({
        error: 'Free generation used. Subscribe to Pro for unlimited generations.',
        requiresSubscription: true,
      });
    }

    // Create generation record
    const genResult = await pool.query(
      'INSERT INTO generations (user_id, assignment_text, slide_count, color_theme, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [req.userId, assignmentText, slides, colorTheme, 'processing']
    );
    const generationId = genResult.rows[0].id;

    // Return immediately, process async
    res.status(202).json({ generationId, status: 'processing' });

    // Process in background
    processGeneration(generationId, req.userId, assignmentText, slides, colorTheme).catch(
      (err) => {
        console.error(`Generation ${generationId} failed:`, err);
        pool.query("UPDATE generations SET status = 'failed' WHERE id = $1", [generationId]);
      }
    );
  } catch (err) {
    console.error('Generate error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function processGeneration(generationId, userId, assignmentText, slideCount, colorTheme) {
  // Generate content with Claude
  const content = await generatePresentationContent(assignmentText, slideCount, colorTheme);

  // Build files
  const [pptxBuffer, docxBuffer] = await Promise.all([
    generatePptxBuffer(content, colorTheme),
    generateDocxBuffer(content),
  ]);

  // Store in DB
  await pool.query(
    "UPDATE generations SET status = 'completed', pptx_data = $1, docx_data = $2 WHERE id = $3",
    [pptxBuffer, docxBuffer, generationId]
  );

  // Increment free generation counter if applicable
  await pool.query(
    "UPDATE users SET free_generations_used = free_generations_used + 1 WHERE id = $1 AND subscription_status = 'free'",
    [userId]
  );
}

router.get('/:id/status', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, status, slide_count, color_theme, created_at FROM generations WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Generation not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Status check error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id/download/:type', authMiddleware, async (req, res) => {
  try {
    const { type } = req.params;
    if (type !== 'pptx' && type !== 'docx') {
      return res.status(400).json({ error: 'Type must be pptx or docx' });
    }

    const column = type === 'pptx' ? 'pptx_data' : 'docx_data';
    const result = await pool.query(
      `SELECT ${column}, status FROM generations WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Generation not found' });
    }

    if (result.rows[0].status !== 'completed') {
      return res.status(400).json({ error: 'Generation not yet completed' });
    }

    const data = result.rows[0][column];
    if (!data) {
      return res.status(404).json({ error: 'File not found' });
    }

    const contentType =
      type === 'pptx'
        ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="presentation.${type}"`);
    res.send(data);
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
