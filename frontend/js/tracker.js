// Tracker page logic — requires api.js and auth.js

document.addEventListener('DOMContentLoaded', async () => {
  if (!auth.requireAuth()) return;

  const setupSection = document.getElementById('setup-section');
  const dashboardSection = document.getElementById('dashboard-section');

  // Check if user has LMS credentials
  try {
    const { hasCredentials, credentials } = await api.trackerGetCredentials();

    if (hasCredentials) {
      showDashboard(credentials[0]);
    } else {
      showSetup();
    }
  } catch (err) {
    console.error('Tracker init error:', err);
    if (err.status === 401) auth.logout();
    showSetup();
  }

  // ─── Setup Form ──────────────────────────────────────────────────────────

  function showSetup() {
    setupSection.classList.remove('hidden');
    dashboardSection.classList.add('hidden');

    const form = document.getElementById('credentials-form');
    const errorEl = document.getElementById('setup-error');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.classList.add('hidden');

      const lmsUrl = document.getElementById('lms-url').value.trim();
      const username = document.getElementById('lms-username').value.trim();
      const password = document.getElementById('lms-password').value;

      if (!lmsUrl || !username || !password) {
        errorEl.textContent = 'All fields are required.';
        errorEl.classList.remove('hidden');
        return;
      }

      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.textContent = 'Connecting...';

      try {
        await api.trackerSaveCredentials(lmsUrl, username, password);
        // Trigger first sync
        const { syncId } = await api.trackerStartSync();

        setupSection.classList.add('hidden');
        dashboardSection.classList.remove('hidden');

        pollSync(syncId);
        loadDashboardData();
      } catch (err) {
        errorEl.textContent = err.message || 'Failed to connect. Check your credentials.';
        errorEl.classList.remove('hidden');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Connect & Start First Sync';
      }
    });
  }

  // ─── Dashboard ───────────────────────────────────────────────────────────

  function showDashboard(credentialInfo) {
    setupSection.classList.add('hidden');
    dashboardSection.classList.remove('hidden');

    if (credentialInfo?.lastSyncAt) {
      document.getElementById('last-sync').textContent =
        `Last synced: ${formatRelativeTime(new Date(credentialInfo.lastSyncAt))}`;
    }

    loadDashboardData();

    // Sync button
    document.getElementById('sync-btn').addEventListener('click', async () => {
      try {
        const { syncId } = await api.trackerStartSync();
        pollSync(syncId);
      } catch (err) {
        if (err.status === 409) {
          alert('A sync is already in progress.');
        } else {
          alert(err.message || 'Failed to start sync.');
        }
      }
    });

    // Settings modal
    const modal = document.getElementById('settings-modal');
    document.getElementById('settings-btn').addEventListener('click', () => {
      const info = document.getElementById('current-lms-info');
      info.textContent = credentialInfo
        ? `Connected to: ${credentialInfo.lmsUrl}`
        : 'No LMS connected';
      modal.classList.remove('hidden');
    });

    document.getElementById('close-settings').addEventListener('click', () => {
      modal.classList.add('hidden');
    });

    document.getElementById('disconnect-lms').addEventListener('click', async () => {
      if (!confirm('Disconnect your LMS? This will remove your saved credentials and all tracked data.')) return;

      try {
        await api.trackerDeleteCredentials();
        window.location.reload();
      } catch (err) {
        alert('Failed to disconnect: ' + (err.message || 'Unknown error'));
      }
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.add('hidden');
    });

    // Filters
    document.getElementById('filter-course').addEventListener('change', renderAssignments);
    document.getElementById('filter-status').addEventListener('change', renderAssignments);
    document.getElementById('filter-type').addEventListener('change', renderAssignments);
  }

  // ─── Data Loading ────────────────────────────────────────────────────────

  let allAssignments = [];
  let allCourses = [];

  async function loadDashboardData() {
    try {
      const [summaryData, assignmentsData, coursesData] = await Promise.all([
        api.trackerGetSummary(),
        api.trackerGetAssignments(),
        api.trackerGetCourses(),
      ]);

      // Update stats
      document.getElementById('stat-due-week').textContent = summaryData.dueThisWeek;
      document.getElementById('stat-overdue').textContent = summaryData.overdueAssignments;
      document.getElementById('stat-completed').textContent = summaryData.completedAssignments;
      document.getElementById('stat-courses').textContent = summaryData.totalCourses;

      if (summaryData.lastSyncAt) {
        document.getElementById('last-sync').textContent =
          `Last synced: ${formatRelativeTime(new Date(summaryData.lastSyncAt))}`;
      }

      // Urgency banner
      updateUrgencyBanner(summaryData);

      // Store data and populate filters
      allAssignments = assignmentsData.assignments;
      allCourses = coursesData.courses;
      populateCourseFilter(allCourses);
      renderAssignments();
    } catch (err) {
      console.error('Load dashboard data error:', err);
    }
  }

  function updateUrgencyBanner(stats) {
    const banner = document.getElementById('urgency-banner');

    if (stats.overdueAssignments > 0) {
      banner.className = 'urgency-banner urgency-red';
      banner.textContent = `${stats.overdueAssignments} overdue assignment${stats.overdueAssignments > 1 ? 's' : ''} need your attention!`;
      banner.classList.remove('hidden');
    } else if (stats.dueThisWeek > 0) {
      banner.className = 'urgency-banner urgency-yellow';
      banner.textContent = `${stats.dueThisWeek} assignment${stats.dueThisWeek > 1 ? 's' : ''} due this week`;
      banner.classList.remove('hidden');
    } else if (stats.totalAssignments > 0) {
      banner.className = 'urgency-banner urgency-green';
      banner.textContent = 'You\'re all caught up!';
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  }

  function populateCourseFilter(courses) {
    const select = document.getElementById('filter-course');
    select.innerHTML = '<option value="all">All Courses</option>';
    courses.forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.code || c.name;
      opt.textContent = c.code ? `${c.code} — ${c.name}` : c.name;
      select.appendChild(opt);
    });
  }

  // ─── Render Assignments ──────────────────────────────────────────────────

  function renderAssignments() {
    const courseFilter = document.getElementById('filter-course').value;
    const statusFilter = document.getElementById('filter-status').value;
    const typeFilter = document.getElementById('filter-type').value;

    let filtered = [...allAssignments];

    if (courseFilter !== 'all') {
      filtered = filtered.filter(
        (a) => a.courseCode === courseFilter || a.courseName === courseFilter
      );
    }

    if (statusFilter !== 'all') {
      if (statusFilter === 'overdue') {
        filtered = filtered.filter((a) => a.urgency === 'overdue');
      } else {
        filtered = filtered.filter((a) => a.submissionStatus === statusFilter);
      }
    }

    if (typeFilter !== 'all') {
      filtered = filtered.filter((a) => a.assignmentType === typeFilter);
    }

    const container = document.getElementById('assignments-list');
    const emptyState = document.getElementById('empty-assignments');

    if (filtered.length === 0) {
      container.innerHTML = '';
      emptyState.classList.remove('hidden');
      return;
    }

    emptyState.classList.add('hidden');

    // Group by course
    const grouped = {};
    filtered.forEach((a) => {
      const key = a.courseCode || a.courseName;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(a);
    });

    let html = '';
    for (const [courseName, assignments] of Object.entries(grouped)) {
      html += `<div class="course-group-header">${escapeHtml(courseName)}</div>`;

      assignments.forEach((a) => {
        html += buildAssignmentCard(a);
      });
    }

    container.innerHTML = html;

    // Attach "Generate Presentation" button handlers
    container.querySelectorAll('.gen-pres-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const title = btn.dataset.title;
        const desc = btn.dataset.description || '';
        // Navigate to generator with pre-filled text
        const text = desc || title;
        localStorage.setItem('prefill_assignment', text);
        window.location.href = 'app.html';
      });
    });
  }

  function buildAssignmentCard(a) {
    const dueBadge = a.dueDate ? buildDueBadge(a.dueDate, a.urgency) : '<span class="due-badge">No due date</span>';
    const pointsText = a.pointsPossible ? `${a.pointsPossible} pts` : '';
    const statusBadge = buildStatusBadge(a.submissionStatus);
    const typeBadge = a.assignmentType === 'quiz' ? '<span style="color: var(--primary); font-weight: 600;">Quiz</span>' : '';

    const titleHtml = a.assignmentUrl
      ? `<a href="${escapeHtml(a.assignmentUrl)}" target="_blank" rel="noopener">${escapeHtml(a.title)}</a>`
      : escapeHtml(a.title);

    return `
      <div class="assignment-card urgency-${a.urgency}">
        <div class="assignment-info">
          <div class="assignment-title">${titleHtml}</div>
          <div class="assignment-meta">
            ${dueBadge}
            ${pointsText ? `<span>${pointsText}</span>` : ''}
            ${statusBadge}
            ${typeBadge}
          </div>
        </div>
        <div class="assignment-actions">
          <button class="btn btn-primary gen-pres-btn" data-title="${escapeAttr(a.title)}" data-description="${escapeAttr(a.description || '')}">
            Generate Slides
          </button>
        </div>
      </div>
    `;
  }

  function buildDueBadge(dateStr, urgency) {
    const date = new Date(dateStr);
    const formatted = date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });

    const classMap = {
      overdue: 'due-overdue',
      due_today: 'due-today',
      due_soon: 'due-soon',
      this_week: 'due-week',
      upcoming: 'due-upcoming',
    };

    const labelMap = {
      overdue: 'OVERDUE',
      due_today: 'DUE TODAY',
      due_soon: 'Due soon',
      this_week: '',
      upcoming: '',
    };

    const cssClass = classMap[urgency] || '';
    const prefix = labelMap[urgency] ? `${labelMap[urgency]} — ` : '';

    return `<span class="due-badge ${cssClass}">${prefix}${formatted}</span>`;
  }

  function buildStatusBadge(status) {
    const map = {
      not_submitted: '<span class="status-badge status-pending">Not submitted</span>',
      submitted: '<span class="status-badge status-completed">Submitted</span>',
      graded: '<span class="status-badge status-completed">Graded</span>',
      overdue: '<span class="status-badge status-failed">Overdue</span>',
    };
    return map[status] || '';
  }

  // ─── Sync Polling ────────────────────────────────────────────────────────

  async function pollSync(syncId) {
    const progressEl = document.getElementById('sync-progress');
    const statusText = document.getElementById('sync-status-text');

    progressEl.classList.remove('hidden');
    statusText.textContent = 'Starting sync...';

    const messages = [
      'Logging in to Brightspace...',
      'Discovering your courses...',
      'Scanning assignments...',
      'Extracting due dates and rubrics...',
      'Almost done...',
    ];
    let msgIndex = 0;

    const msgInterval = setInterval(() => {
      msgIndex = Math.min(msgIndex + 1, messages.length - 1);
      statusText.textContent = messages[msgIndex];
    }, 4000);

    try {
      let attempts = 0;
      while (attempts < 90) {
        await sleep(2000);
        const status = await api.trackerGetSyncStatus(syncId);

        if (status.status === 'completed') {
          clearInterval(msgInterval);
          statusText.textContent = `Sync complete! Found ${status.coursesFound} courses, ${status.assignmentsFound} assignments.`;
          setTimeout(() => {
            progressEl.classList.add('hidden');
          }, 3000);
          loadDashboardData();
          return;
        }

        if (status.status === 'failed') {
          clearInterval(msgInterval);
          statusText.textContent = `Sync failed: ${status.errorMessage || 'Unknown error'}`;
          statusText.style.color = 'var(--error)';
          setTimeout(() => {
            progressEl.classList.add('hidden');
            statusText.style.color = '';
          }, 5000);
          return;
        }

        attempts++;
      }

      clearInterval(msgInterval);
      statusText.textContent = 'Sync timed out. Please try again.';
      setTimeout(() => progressEl.classList.add('hidden'), 3000);
    } catch (err) {
      clearInterval(msgInterval);
      progressEl.classList.add('hidden');
      console.error('Sync poll error:', err);
    }
  }

  // ─── Utility Functions ───────────────────────────────────────────────────

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function formatRelativeTime(date) {
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
});
