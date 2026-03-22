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
    let { assignmentText, slideCount = 10, colorTheme = 'professional', assignmentId } = req.body;

    // If assignmentId provided, build rich context from deep-crawled data
    if (assignmentId) {
      const aResult = await pool.query(
        `SELECT a.title, a.full_instructions, a.rubric_text, a.requirements, a.attachment_names,
                a.points_possible, a.due_date, a.assignment_type,
                c.course_name, c.course_code
         FROM tracked_assignments a
         JOIN tracked_courses c ON a.course_id = c.id
         WHERE a.id = $1 AND a.user_id = $2`,
        [assignmentId, req.userId]
      );

      if (aResult.rows.length > 0) {
        const a = aResult.rows[0];
        const parts = [];

        parts.push(`COURSE: ${a.course_name}${a.course_code ? ` (${a.course_code})` : ''}`);
        parts.push(`ASSIGNMENT: ${a.title}`);
        if (a.points_possible) parts.push(`POINTS: ${a.points_possible}`);
        if (a.due_date) parts.push(`DUE: ${new Date(a.due_date).toLocaleDateString()}`);

        if (a.full_instructions) {
          parts.push(`\nFULL INSTRUCTIONS:\n${a.full_instructions}`);
        }

        if (a.rubric_text) {
          parts.push(`\nRUBRIC/GRADING CRITERIA:\n${a.rubric_text}`);
        }

        if (a.requirements) {
          try {
            const reqs = JSON.parse(a.requirements);
            if (Array.isArray(reqs) && reqs.length > 0) {
              parts.push(`\nKEY REQUIREMENTS:\n${reqs.map(r => `- ${r}`).join('\n')}`);
            }
          } catch (e) { /* ignore parse errors */ }
        }

        if (a.attachment_names) {
          try {
            const files = JSON.parse(a.attachment_names);
            if (Array.isArray(files) && files.length > 0) {
              parts.push(`\nATTACHMENTS: ${files.join(', ')}`);
            }
          } catch (e) { /* ignore parse errors */ }
        }

        // Use rich context, but keep user text as additional notes if provided
        const richContext = parts.join('\n');
        assignmentText = assignmentText
          ? `${richContext}\n\nADDITIONAL NOTES FROM STUDENT:\n${assignmentText}`
          : richContext;
      }
    }

    if (!assignmentText || assignmentText.trim().length === 0) {
      return res.status(400).json({ error: 'Assignment text is required' });
    }

    // Allow larger text when using deep content
    const maxLen = assignmentId ? 50000 : 10000;
    if (assignmentText.length > maxLen) {
      assignmentText = assignmentText.substring(0, maxLen);
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
