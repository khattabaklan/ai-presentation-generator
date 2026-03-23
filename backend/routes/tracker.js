const express = require('express');
const pool = require('../config/db');
const authMiddleware = require('../middleware/auth');
const { parsePageContent } = require('../services/claude');
const { syncBrightspace } = require('../services/lmsCrawler');
const { encrypt, decrypt } = require('../services/cryptoUtil');

const router = express.Router();

// Track active sync jobs so we can update progress in-memory
const activeSyncs = new Map();

// ─── Parse Page with Claude (Deep Crawl) ────────────────────────────────────

router.post('/parse-page', authMiddleware, async (req, res) => {
  try {
    const { text, pageType, courseId } = req.body;

    if (!text || !pageType) {
      return res.status(400).json({ error: 'text and pageType are required' });
    }

    // Cap input to avoid massive token usage
    const truncated = text.substring(0, 100000);
    const parsed = await parsePageContent(truncated, pageType, courseId);

    res.json(parsed);
  } catch (err) {
    console.error('Parse page error:', err.message || err);
    res.status(500).json({ error: `Parse failed: ${err.message || 'Unknown error'}` });
  }
});

// ─── Shared Deep Crawl Save Logic ───────────────────────────────────────────

/**
 * Saves deep crawl results to the database.
 * Used by both the /deep-import route (Chrome extension) and runSync() (server-side).
 */
async function saveDeepCrawlResults(userId, results) {
  const { courses, assignments, quizzes, materials } = results;

  let coursesImported = 0;
  let assignmentsImported = 0;
  let materialsImported = 0;

  // Upsert courses
  if (courses && Array.isArray(courses)) {
    for (const course of courses) {
      // Accept both shapes: { courseId } (extension) and { platformCourseId } (old scraper)
      const platformId = course.courseId || course.platformCourseId;
      const name = course.name || course.courseName;
      const code = course.code || course.courseCode;

      await pool.query(
        `INSERT INTO tracked_courses (user_id, platform, platform_course_id, course_name, course_code, course_url, last_crawled_at, deep_crawled_at)
         VALUES ($1, 'brightspace', $2, $3, $4, $5, NOW(), NOW())
         ON CONFLICT (user_id, platform_course_id) DO UPDATE SET
           course_name = EXCLUDED.course_name,
           course_code = EXCLUDED.course_code,
           course_url = EXCLUDED.course_url,
           last_crawled_at = NOW(),
           deep_crawled_at = NOW(),
           updated_at = NOW()`,
        [userId, platformId, name, code, course.url]
      );
      coursesImported++;
    }
  }

  // Upsert assignments with deep content
  if (assignments && Array.isArray(assignments)) {
    for (const a of assignments) {
      const platformCourseId = a.courseId;
      const courseResult = await pool.query(
        'SELECT id FROM tracked_courses WHERE user_id = $1 AND platform_course_id = $2',
        [userId, platformCourseId]
      );
      if (courseResult.rows.length === 0) continue;
      const dbCourseId = courseResult.rows[0].id;

      const assignmentId = a.assignmentId || a.platformAssignmentId || `${platformCourseId}_${(a.title || '').slice(0, 30)}`;

      await pool.query(
        `INSERT INTO tracked_assignments (course_id, user_id, platform_assignment_id, title, due_date, points_possible, submission_status, assignment_type, assignment_url, full_instructions, rubric_text, requirements, attachment_names, deep_crawled_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
         ON CONFLICT (course_id, platform_assignment_id) DO UPDATE SET
           title = EXCLUDED.title,
           due_date = EXCLUDED.due_date,
           points_possible = EXCLUDED.points_possible,
           submission_status = EXCLUDED.submission_status,
           assignment_type = EXCLUDED.assignment_type,
           assignment_url = EXCLUDED.assignment_url,
           full_instructions = COALESCE(EXCLUDED.full_instructions, tracked_assignments.full_instructions),
           rubric_text = COALESCE(EXCLUDED.rubric_text, tracked_assignments.rubric_text),
           requirements = COALESCE(EXCLUDED.requirements, tracked_assignments.requirements),
           attachment_names = COALESCE(EXCLUDED.attachment_names, tracked_assignments.attachment_names),
           deep_crawled_at = CASE WHEN EXCLUDED.full_instructions IS NOT NULL THEN NOW() ELSE tracked_assignments.deep_crawled_at END,
           updated_at = NOW()`,
        [
          dbCourseId, userId, assignmentId, a.title,
          a.dueDate, a.points || a.pointsPossible, a.status || a.submissionStatus || 'not_submitted',
          a.assignmentType || 'dropbox', a.assignmentUrl,
          a.fullInstructions, a.rubric || a.rubricText,
          a.requirements ? JSON.stringify(a.requirements) : null,
          a.attachments ? JSON.stringify(a.attachments) : null,
        ]
      );
      assignmentsImported++;
    }
  }

  // Upsert quizzes as assignments with type 'quiz'
  if (quizzes && Array.isArray(quizzes)) {
    for (const q of quizzes) {
      const courseResult = await pool.query(
        'SELECT id FROM tracked_courses WHERE user_id = $1 AND platform_course_id = $2',
        [userId, q.courseId]
      );
      if (courseResult.rows.length === 0) continue;
      const dbCourseId = courseResult.rows[0].id;

      await pool.query(
        `INSERT INTO tracked_assignments (course_id, user_id, platform_assignment_id, title, due_date, submission_status, assignment_type)
         VALUES ($1, $2, $3, $4, $5, $6, 'quiz')
         ON CONFLICT (course_id, platform_assignment_id) DO UPDATE SET
           title = EXCLUDED.title,
           due_date = EXCLUDED.due_date,
           submission_status = EXCLUDED.submission_status,
           updated_at = NOW()`,
        [dbCourseId, userId, q.quizId || `quiz_${q.title}`, q.title, q.dueDate, q.status || 'not_submitted']
      );
      assignmentsImported++;
    }
  }

  // Insert course materials
  if (materials && Array.isArray(materials)) {
    for (const m of materials) {
      const courseResult = await pool.query(
        'SELECT id FROM tracked_courses WHERE user_id = $1 AND platform_course_id = $2',
        [userId, m.courseId]
      );
      if (courseResult.rows.length === 0) continue;
      const dbCourseId = courseResult.rows[0].id;

      if (m.topics && Array.isArray(m.topics)) {
        for (let i = 0; i < m.topics.length; i++) {
          const t = m.topics[i];
          await pool.query(
            `INSERT INTO tracked_course_materials (course_id, user_id, module_name, topic_title, topic_type, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [dbCourseId, userId, m.moduleName, t.title, t.type, i]
          );
          materialsImported++;
        }
      }
    }
  }

  return { coursesImported, assignmentsImported, materialsImported };
}

// ─── Deep Import (with full instructions, rubric, materials) ────────────────

router.post('/deep-import', authMiddleware, async (req, res) => {
  try {
    const result = await saveDeepCrawlResults(req.userId, req.body);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Deep import error:', err);
    res.status(500).json({ error: 'Failed to import deep crawl data' });
  }
});

// ─── Import from Chrome Extension ───────────────────────────────────────────

router.post('/import', authMiddleware, async (req, res) => {
  try {
    const { courses, assignments, lmsUrl } = req.body;

    if (!courses || !Array.isArray(courses) || courses.length === 0) {
      return res.status(400).json({ error: 'No courses provided' });
    }

    let coursesImported = 0;
    let assignmentsImported = 0;

    // Upsert courses
    for (const course of courses) {
      await pool.query(
        `INSERT INTO tracked_courses (user_id, platform, platform_course_id, course_name, course_code, course_url, last_crawled_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (user_id, platform_course_id) DO UPDATE SET
           course_name = EXCLUDED.course_name,
           course_code = EXCLUDED.course_code,
           course_url = EXCLUDED.course_url,
           last_crawled_at = NOW(),
           updated_at = NOW()`,
        [req.userId, 'brightspace', course.platformCourseId, course.name, course.courseCode, course.url]
      );
      coursesImported++;
    }

    // Upsert assignments
    for (const assignment of assignments) {
      // Look up internal course ID
      const courseResult = await pool.query(
        'SELECT id FROM tracked_courses WHERE user_id = $1 AND platform_course_id = $2',
        [req.userId, assignment.courseId]
      );

      if (courseResult.rows.length === 0) continue;
      const dbCourseId = courseResult.rows[0].id;

      await pool.query(
        `INSERT INTO tracked_assignments (course_id, user_id, platform_assignment_id, title, due_date, points_possible, submission_status, assignment_type, assignment_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (course_id, platform_assignment_id) DO UPDATE SET
           title = EXCLUDED.title,
           due_date = EXCLUDED.due_date,
           points_possible = EXCLUDED.points_possible,
           submission_status = EXCLUDED.submission_status,
           assignment_type = EXCLUDED.assignment_type,
           assignment_url = EXCLUDED.assignment_url,
           updated_at = NOW()`,
        [
          dbCourseId, req.userId, assignment.platformAssignmentId, assignment.title,
          assignment.dueDate, assignment.pointsPossible, assignment.submissionStatus,
          assignment.assignmentType, assignment.assignmentUrl,
        ]
      );
      assignmentsImported++;
    }

    res.json({ success: true, coursesImported, assignmentsImported });
  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ error: 'Failed to import assignments' });
  }
});

// ─── Save LMS credentials (encrypted) ────────────────────────────────────────

router.post('/credentials', authMiddleware, async (req, res) => {
  try {
    const { lmsUrl, username, password } = req.body;

    if (!lmsUrl || !username || !password) {
      return res.status(400).json({ error: 'lmsUrl, username, and password are required' });
    }

    // Encrypt credentials
    const encUser = encrypt(username);
    const encPass = encrypt(password);

    await pool.query(
      `INSERT INTO lms_credentials (user_id, platform, lms_url, encrypted_username, encrypted_password, encryption_iv, encryption_tag)
       VALUES ($1, 'brightspace', $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, platform) DO UPDATE SET
         lms_url = EXCLUDED.lms_url,
         encrypted_username = EXCLUDED.encrypted_username,
         encrypted_password = EXCLUDED.encrypted_password,
         encryption_iv = EXCLUDED.encryption_iv,
         encryption_tag = EXCLUDED.encryption_tag,
         updated_at = NOW()`,
      [req.userId, lmsUrl, encUser.encrypted, encPass.encrypted, encUser.iv, encUser.tag]
    );

    // Store password IV/tag separately — credentials table only has one iv/tag pair,
    // so we store both as JSON
    await pool.query(
      `UPDATE lms_credentials SET
         encryption_iv = $1,
         encryption_tag = $2
       WHERE user_id = $3 AND platform = 'brightspace'`,
      [
        JSON.stringify({ user: encUser.iv, pass: encPass.iv }),
        JSON.stringify({ user: encUser.tag, pass: encPass.tag }),
        req.userId,
      ]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Save credentials error:', err);
    res.status(500).json({ error: 'Failed to save credentials' });
  }
});

// ─── Server-side Sync (Playwright scraper) ───────────────────────────────────

router.post('/sync', authMiddleware, async (req, res) => {
  try {
    // Get stored credentials
    const credResult = await pool.query(
      'SELECT * FROM lms_credentials WHERE user_id = $1 AND platform = $2',
      [req.userId, 'brightspace']
    );

    if (credResult.rows.length === 0) {
      return res.status(400).json({ error: 'No saved credentials. Save your LMS credentials first.' });
    }

    const cred = credResult.rows[0];

    // Decrypt
    let ivData, tagData;
    try {
      ivData = JSON.parse(cred.encryption_iv);
      tagData = JSON.parse(cred.encryption_tag);
    } catch {
      return res.status(400).json({ error: 'Stored credentials are corrupted. Please re-save them.' });
    }

    const username = decrypt(cred.encrypted_username, ivData.user, tagData.user);
    const password = decrypt(cred.encrypted_password, ivData.pass, tagData.pass);
    const lmsUrl = cred.lms_url;

    // Create a sync job
    const jobResult = await pool.query(
      `INSERT INTO sync_jobs (user_id, status, started_at)
       VALUES ($1, 'running', NOW())
       RETURNING id`,
      [req.userId]
    );
    const jobId = jobResult.rows[0].id;

    // Track progress in memory
    activeSyncs.set(jobId, { progress: 'Starting sync...' });

    // Return immediately — sync runs in background
    res.json({ jobId, status: 'running' });

    // Run sync asynchronously
    runSync(jobId, req.userId, lmsUrl, username, password).catch((err) => {
      console.error(`Sync job ${jobId} crashed:`, err);
    });
  } catch (err) {
    console.error('Start sync error:', err);
    res.status(500).json({ error: 'Failed to start sync' });
  }
});

/**
 * Background sync job — runs deep Playwright scraper and stores results in DB.
 */
async function runSync(jobId, userId, lmsUrl, username, password) {
  try {
    const onProgress = (msg) => {
      const entry = activeSyncs.get(jobId);
      if (entry) entry.progress = msg;
    };

    const results = await syncBrightspace(lmsUrl, username, password, onProgress);

    // Save all deep crawl results using the shared function
    onProgress('Saving results to database...');
    await saveDeepCrawlResults(userId, results);

    // Update job as complete
    const totalAssignments = (results.assignments?.length || 0) + (results.quizzes?.length || 0);
    await pool.query(
      `UPDATE sync_jobs SET status = 'completed', courses_found = $1, assignments_found = $2, completed_at = NOW()
       WHERE id = $3`,
      [results.courses?.length || 0, totalAssignments, jobId]
    );

    // Update credential last_sync_at
    await pool.query(
      'UPDATE lms_credentials SET last_sync_at = NOW() WHERE user_id = $1 AND platform = $2',
      [userId, 'brightspace']
    );

    activeSyncs.delete(jobId);
  } catch (err) {
    console.error(`Sync job ${jobId} failed:`, err.message);

    await pool.query(
      `UPDATE sync_jobs SET status = 'failed', error_message = $1, completed_at = NOW()
       WHERE id = $2`,
      [err.message, jobId]
    ).catch(() => {});

    activeSyncs.delete(jobId);
  }
}

// ─── Delete LMS credentials and data ─────────────────────────────────────────

router.delete('/credentials', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM lms_credentials WHERE user_id = $1', [req.userId]);
    await pool.query('DELETE FROM tracked_assignments WHERE user_id = $1', [req.userId]);
    await pool.query('DELETE FROM tracked_courses WHERE user_id = $1', [req.userId]);

    res.json({ success: true });
  } catch (err) {
    console.error('Delete credentials error:', err);
    res.status(500).json({ error: 'Failed to delete data' });
  }
});

// ─── Check if credentials exist ──────────────────────────────────────────────

router.get('/credentials', authMiddleware, async (req, res) => {
  try {
    const [credResult, courseResult] = await Promise.all([
      pool.query(
        'SELECT lms_url, last_sync_at FROM lms_credentials WHERE user_id = $1 AND platform = $2',
        [req.userId, 'brightspace']
      ),
      pool.query(
        'SELECT COUNT(*) as count FROM tracked_courses WHERE user_id = $1',
        [req.userId]
      ),
    ]);

    const hasCredentials = credResult.rows.length > 0;
    const hasData = parseInt(courseResult.rows[0].count) > 0;
    const cred = credResult.rows[0];

    res.json({
      hasCredentials: hasCredentials || hasData,
      hasSavedLogin: hasCredentials,
      credentials: hasCredentials
        ? [{ lmsUrl: cred.lms_url, lastSyncAt: cred.last_sync_at }]
        : hasData
          ? [{ lmsUrl: 'Synced via extension', lastSyncAt: new Date() }]
          : [],
    });
  } catch (err) {
    console.error('Check data error:', err);
    res.status(500).json({ error: 'Failed to check data' });
  }
});

// ─── Get sync status (kept for backwards compat) ────────────────────────────

router.get('/sync/:id', authMiddleware, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);

    const result = await pool.query(
      'SELECT * FROM sync_jobs WHERE id = $1 AND user_id = $2',
      [jobId, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Sync job not found' });
    }

    const job = result.rows[0];

    // Include live progress message if sync is still running
    const activeSync = activeSyncs.get(jobId);

    res.json({
      id: job.id,
      status: job.status,
      progress: activeSync ? activeSync.progress : null,
      phase: activeSync ? activeSync.phase : (job.status === 'completed' ? 'done' : null),
      coursesFound: job.courses_found,
      assignmentsFound: job.assignments_found,
      errorMessage: job.error_message,
      startedAt: job.started_at,
      completedAt: job.completed_at,
    });
  } catch (err) {
    console.error('Sync status error:', err);
    res.status(500).json({ error: 'Failed to check sync status' });
  }
});

// ─── Get all assignments (the main dashboard data) ──────────────────────────

router.get('/assignments', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
        a.id, a.title, a.description, a.due_date, a.points_possible,
        a.submission_status, a.grade, a.assignment_type, a.assignment_url,
        a.full_instructions, a.rubric_text, a.requirements, a.attachment_names,
        a.updated_at,
        c.course_name, c.course_code, c.platform_course_id
       FROM tracked_assignments a
       JOIN tracked_courses c ON a.course_id = c.id
       WHERE a.user_id = $1
       ORDER BY
         CASE WHEN a.due_date IS NULL THEN 1 ELSE 0 END,
         a.due_date ASC`,
      [req.userId]
    );

    // Compute urgency categories
    const now = new Date();
    const assignments = result.rows.map((row) => {
      const dueDate = row.due_date ? new Date(row.due_date) : null;
      let urgency = 'none';

      if (dueDate) {
        const daysUntilDue = (dueDate - now) / (1000 * 60 * 60 * 24);
        if (daysUntilDue < 0) urgency = 'overdue';
        else if (daysUntilDue < 1) urgency = 'due_today';
        else if (daysUntilDue < 3) urgency = 'due_soon';
        else if (daysUntilDue < 7) urgency = 'this_week';
        else urgency = 'upcoming';
      }

      return {
        id: row.id,
        title: row.title,
        description: row.description,
        dueDate: row.due_date,
        pointsPossible: row.points_possible,
        submissionStatus: row.submission_status,
        grade: row.grade,
        assignmentType: row.assignment_type,
        assignmentUrl: row.assignment_url,
        fullInstructions: row.full_instructions,
        rubricText: row.rubric_text,
        requirements: row.requirements,
        attachmentNames: row.attachment_names,
        updatedAt: row.updated_at,
        courseName: row.course_name,
        courseCode: row.course_code,
        urgency,
      };
    });

    res.json({ assignments });
  } catch (err) {
    console.error('Get assignments error:', err);
    res.status(500).json({ error: 'Failed to load assignments' });
  }
});

// ─── Get courses ────────────────────────────────────────────────────────────

router.get('/courses', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*,
        COUNT(a.id) as assignment_count,
        COUNT(CASE WHEN a.submission_status = 'submitted' OR a.submission_status = 'graded' THEN 1 END) as completed_count
       FROM tracked_courses c
       LEFT JOIN tracked_assignments a ON a.course_id = c.id
       WHERE c.user_id = $1
       GROUP BY c.id
       ORDER BY c.course_name`,
      [req.userId]
    );

    res.json({
      courses: result.rows.map((r) => ({
        id: r.id,
        name: r.course_name,
        code: r.course_code,
        url: r.course_url,
        assignmentCount: parseInt(r.assignment_count),
        completedCount: parseInt(r.completed_count),
        lastCrawledAt: r.last_crawled_at,
      })),
    });
  } catch (err) {
    console.error('Get courses error:', err);
    res.status(500).json({ error: 'Failed to load courses' });
  }
});

// ─── Dashboard summary stats ────────────────────────────────────────────────

router.get('/summary', authMiddleware, async (req, res) => {
  try {
    const now = new Date();
    const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const [assignmentStats, courseCount] = await Promise.all([
      pool.query(
        `SELECT
          COUNT(*) as total,
          COUNT(CASE WHEN submission_status IN ('submitted', 'graded') THEN 1 END) as completed,
          COUNT(CASE WHEN due_date < NOW() AND submission_status = 'not_submitted' THEN 1 END) as overdue,
          COUNT(CASE WHEN due_date BETWEEN NOW() AND $2 AND submission_status = 'not_submitted' THEN 1 END) as due_this_week
         FROM tracked_assignments WHERE user_id = $1`,
        [req.userId, weekFromNow]
      ),
      pool.query('SELECT COUNT(*) as count FROM tracked_courses WHERE user_id = $1', [req.userId]),
    ]);

    const stats = assignmentStats.rows[0];
    res.json({
      totalAssignments: parseInt(stats.total),
      completedAssignments: parseInt(stats.completed),
      overdueAssignments: parseInt(stats.overdue),
      dueThisWeek: parseInt(stats.due_this_week),
      totalCourses: parseInt(courseCount.rows[0].count),
      lastSyncAt: null,
    });
  } catch (err) {
    console.error('Summary error:', err);
    res.status(500).json({ error: 'Failed to load summary' });
  }
});

module.exports = router;
