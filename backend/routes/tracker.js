const express = require('express');
const pool = require('../config/db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

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

// ─── Check if credentials exist (legacy — now checks for any tracked data) ──

router.get('/credentials', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT COUNT(*) as count FROM tracked_courses WHERE user_id = $1',
      [req.userId]
    );

    const hasData = parseInt(result.rows[0].count) > 0;

    res.json({
      hasCredentials: hasData,
      credentials: hasData ? [{ lmsUrl: 'Synced via extension', lastSyncAt: new Date() }] : [],
    });
  } catch (err) {
    console.error('Check data error:', err);
    res.status(500).json({ error: 'Failed to check data' });
  }
});

// ─── Get sync status (kept for backwards compat) ────────────────────────────

router.get('/sync/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM sync_jobs WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Sync job not found' });
    }

    const job = result.rows[0];
    res.json({
      id: job.id,
      status: job.status,
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
