// Tracker page logic — requires api.js and auth.js

document.addEventListener('DOMContentLoaded', async () => {
  const setupSection = document.getElementById('setup-section');
  const dashboardSection = document.getElementById('dashboard-section');

  // Course colors for visual grouping
  const COURSE_COLORS = [
    '#E8944A', '#6CA4C8', '#7EBF8E', '#D4605A', '#D4A94A',
    '#A78BFA', '#F472B6', '#34D399', '#FB923C', '#60A5FA',
  ];
  const courseColorMap = {};
  let colorIndex = 0;

  function getCourseColor(courseKey) {
    if (!courseColorMap[courseKey]) {
      courseColorMap[courseKey] = COURSE_COLORS[colorIndex % COURSE_COLORS.length];
      colorIndex++;
    }
    return courseColorMap[courseKey];
  }

  // Check if user has any synced data
  try {
    const data = await api.trackerGetCredentials();
    if (data.hasCredentials) {
      // Normalize: hasSavedLogin comes from the API response
      data.hasSavedLogin = data.hasSavedLogin || false;
      showDashboard(data);
    } else {
      showSetup();
    }
  } catch (err) {
    console.error('Tracker init error:', err);
    showSetup();
  }

  // ─── Setup Section ──────────────────────────────────────────────────────────

  function showSetup() {
    setupSection.classList.remove('hidden');
    dashboardSection.classList.add('hidden');

    document.getElementById('setup-login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type="submit"]');
      const lmsUrl = document.getElementById('setup-lms-url').value.replace(/\/+$/, '');
      const username = document.getElementById('setup-username').value;
      const password = document.getElementById('setup-password').value;

      btn.disabled = true;
      btn.textContent = 'Connecting...';

      try {
        await api.trackerSaveCredentials(lmsUrl, username, password);
        showDashboard({ hasSavedLogin: true });
        startServerSync();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Connect & Sync';
        alert('Failed to save credentials: ' + (err.message || 'Unknown error'));
      }
    });
  }

  // ─── Dashboard ───────────────────────────────────────────────────────────

  function showDashboard(credData) {
    setupSection.classList.add('hidden');
    dashboardSection.classList.remove('hidden');

    loadDashboardData();

    // Sync button — always try server sync, backend will error if no credentials
    document.getElementById('sync-btn').addEventListener('click', () => {
      startServerSync();
    });

    // Settings modal
    const modal = document.getElementById('settings-modal');
    document.getElementById('settings-btn').addEventListener('click', () => {
      const info = document.getElementById('current-lms-info');
      if (credData && credData.credentials && credData.credentials[0]) {
        info.innerHTML = 'Connected to: ' + escapeHtml(credData.credentials[0].lmsUrl);
        if (credData.credentials[0].lastSyncAt) {
          info.innerHTML += '<br>Last sync: ' + escapeHtml(formatRelativeTime(new Date(credData.credentials[0].lastSyncAt)));
        }
      } else {
        info.textContent = 'Data synced via Chrome extension';
      }
      modal.classList.remove('hidden');
    });

    document.getElementById('close-settings').addEventListener('click', () => {
      modal.classList.add('hidden');
    });

    // Settings form — save credentials
    document.getElementById('settings-login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const lmsUrl = document.getElementById('settings-lms-url').value.replace(/\/+$/, '');
      const username = document.getElementById('settings-username').value;
      const password = document.getElementById('settings-password').value;

      if (!lmsUrl || !username || !password) {
        alert('Please fill in all fields.');
        return;
      }

      const btn = e.target.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.textContent = 'Saving...';

      try {
        await api.trackerSaveCredentials(lmsUrl, username, password);
        credData = { hasSavedLogin: true };
        modal.classList.add('hidden');
        startServerSync();
      } catch (err) {
        alert('Failed: ' + (err.message || 'Unknown error'));
      } finally {
        btn.disabled = false;
        btn.textContent = 'Save & Sync';
      }
    });

    document.getElementById('disconnect-lms').addEventListener('click', async () => {
      if (!confirm('This will delete all your tracked assignments and saved credentials. Continue?')) return;
      try {
        await api.trackerDeleteCredentials();
        window.location.reload();
      } catch (err) {
        alert('Failed to clear data: ' + (err.message || 'Unknown error'));
      }
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.add('hidden');
    });

    // Filter tabs
    document.querySelectorAll('.filter-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.filter-tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        renderAssignments();
      });
    });

    document.getElementById('filter-course').addEventListener('change', renderAssignments);
    document.getElementById('filter-type').addEventListener('change', renderAssignments);
  }

  // ─── Server-Side Sync ──────────────────────────────────────────────────────

  async function startServerSync() {
    const progressEl = document.getElementById('sync-progress');
    const statusText = document.getElementById('sync-status-text');
    const progressFill = document.getElementById('sync-progress-fill');
    const syncBtn = document.getElementById('sync-btn');

    progressEl.classList.remove('hidden');
    syncBtn.disabled = true;
    statusText.textContent = 'Starting deep scan...';
    progressFill.style.width = '5%';

    try {
      const { jobId } = await api.trackerStartSync();

      // Poll for progress
      const poll = setInterval(async () => {
        try {
          const status = await api.trackerGetSyncStatus(jobId);

          if (status.progress) {
            statusText.textContent = status.progress;
          }

          // Estimate progress based on status text
          if (status.progress) {
            if (status.progress.includes('Logging in')) progressFill.style.width = '5%';
            else if (status.progress.includes('Discovering')) progressFill.style.width = '10%';
            else if (status.progress.includes('Found')) progressFill.style.width = '15%';
            else if (status.progress.includes('content')) progressFill.style.width = '30%';
            else if (status.progress.includes('assignment')) progressFill.style.width = '50%';
            else if (status.progress.includes('quiz')) progressFill.style.width = '70%';
            else if (status.progress.includes('Saving')) progressFill.style.width = '90%';
            else if (status.progress.includes('complete')) progressFill.style.width = '100%';
          }

          if (status.status === 'completed') {
            clearInterval(poll);
            progressFill.style.width = '100%';
            statusText.textContent = `Done! Found ${status.coursesFound || 0} courses, ${status.assignmentsFound || 0} assignments.`;
            syncBtn.disabled = false;

            setTimeout(() => {
              progressEl.classList.add('hidden');
              loadDashboardData();
            }, 2000);
          } else if (status.status === 'failed') {
            clearInterval(poll);
            statusText.textContent = 'Sync failed: ' + (status.errorMessage || 'Unknown error');
            progressFill.style.width = '0%';
            syncBtn.disabled = false;

            setTimeout(() => {
              progressEl.classList.add('hidden');
            }, 5000);
          }
        } catch (err) {
          console.error('Poll error:', err);
          clearInterval(poll);
          statusText.textContent = 'Lost connection. Refresh to check status.';
          syncBtn.disabled = false;
        }
      }, 2000);
    } catch (err) {
      statusText.textContent = 'Failed to start sync: ' + (err.message || 'Unknown error');
      syncBtn.disabled = false;
      setTimeout(() => {
        progressEl.classList.add('hidden');
      }, 3000);
    }
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

      // Update quick glance stats
      const glance = document.getElementById('quick-glance');
      const urgentCount = summaryData.overdueAssignments;
      const urgentEl = document.getElementById('glance-urgent');

      document.getElementById('glance-due-count').textContent = summaryData.dueThisWeek;
      document.getElementById('glance-done-count').textContent = summaryData.completedAssignments;
      document.getElementById('glance-course-count').textContent = summaryData.totalCourses;

      if (urgentCount > 0) {
        document.getElementById('glance-urgent-count').textContent = urgentCount;
        urgentEl.classList.remove('hidden');
      } else {
        urgentEl.classList.add('hidden');
      }

      glance.classList.remove('hidden');

      // Store data and populate filters
      allAssignments = assignmentsData.assignments;
      allCourses = coursesData.courses;
      populateCourseFilter(allCourses);
      renderAssignments();

      // Update last sync time
      const lastSyncEl = document.getElementById('last-sync');
      if (allAssignments.length > 0) {
        const newest = allAssignments.reduce((a, b) =>
          new Date(b.updatedAt) > new Date(a.updatedAt) ? b : a
        );
        lastSyncEl.textContent = 'Last updated ' + formatRelativeTime(new Date(newest.updatedAt));
      }
    } catch (err) {
      console.error('Load dashboard data error:', err);
    }
  }

  function populateCourseFilter(courses) {
    const select = document.getElementById('filter-course');
    select.innerHTML = '<option value="all">All courses</option>';
    courses.forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.code || c.name;
      opt.textContent = c.code ? `${c.code} — ${c.name}` : c.name;
      select.appendChild(opt);
    });
  }

  // ─── Render Assignments ──────────────────────────────────────────────────

  function renderAssignments() {
    const activeTab = document.querySelector('.filter-tab.active');
    const tabFilter = activeTab ? activeTab.dataset.filter : 'all';
    const courseFilter = document.getElementById('filter-course').value;
    const typeFilter = document.getElementById('filter-type').value;

    let filtered = [...allAssignments];

    // Tab filter
    if (tabFilter === 'upcoming') {
      filtered = filtered.filter((a) =>
        ['due_today', 'due_soon', 'this_week', 'upcoming'].includes(a.urgency) &&
        a.submissionStatus !== 'submitted' && a.submissionStatus !== 'graded'
      );
    } else if (tabFilter === 'overdue') {
      filtered = filtered.filter((a) => a.urgency === 'overdue' && a.submissionStatus !== 'submitted');
    } else if (tabFilter === 'submitted') {
      filtered = filtered.filter((a) => a.submissionStatus === 'submitted' || a.submissionStatus === 'graded');
    }

    // Course filter
    if (courseFilter !== 'all') {
      filtered = filtered.filter((a) => a.courseCode === courseFilter || a.courseName === courseFilter);
    }

    // Type filter
    if (typeFilter !== 'all') {
      filtered = filtered.filter((a) => a.assignmentType === typeFilter);
    }

    const container = document.getElementById('assignments-list');
    const emptyState = document.getElementById('empty-assignments');

    if (filtered.length === 0 && allAssignments.length === 0) {
      container.innerHTML = '';
      emptyState.classList.remove('hidden');
      return;
    }

    if (filtered.length === 0) {
      container.innerHTML = '<div class="empty-state" style="padding: 32px;"><p class="empty-subtitle">No assignments match these filters.</p></div>';
      emptyState.classList.add('hidden');
      return;
    }

    emptyState.classList.add('hidden');

    // Group by course
    const grouped = {};
    filtered.forEach((a) => {
      const key = a.courseCode || a.courseName;
      if (!grouped[key]) grouped[key] = { name: a.courseName, code: a.courseCode, items: [] };
      grouped[key].items.push(a);
    });

    let html = '';
    for (const [key, group] of Object.entries(grouped)) {
      const color = getCourseColor(key);
      const displayName = group.code ? `${group.code} — ${group.name}` : group.name;

      html += `<div class="course-group">`;
      html += `<div class="course-group-header">
        <div class="course-color-dot" style="background: ${color};"></div>
        <div class="course-group-name">${escapeHtml(displayName)}</div>
        <div class="course-group-count">${group.items.length} item${group.items.length !== 1 ? 's' : ''}</div>
      </div>`;

      group.items.forEach((a) => {
        html += buildAssignmentCard(a, color);
      });

      html += `</div>`;
    }

    container.innerHTML = html;

    // Attach AI Help button handlers
    container.querySelectorAll('.btn-help').forEach((btn) => {
      btn.addEventListener('click', () => {
        const assignmentId = btn.dataset.assignmentId;
        const assignment = allAssignments.find((a) => String(a.id) === String(assignmentId));
        if (assignment) openGenModal(assignment);
      });
    });
  }

  function buildAssignmentCard(a, courseColor) {
    const isDone = a.submissionStatus === 'submitted' || a.submissionStatus === 'graded';
    const dueBadge = a.dueDate ? buildDueBadge(a.dueDate, a.urgency, isDone) : '<span class="due-badge" style="color: var(--text-muted);">No due date</span>';
    const pointsText = a.pointsPossible ? `${a.pointsPossible} pts` : '';
    const statusBadge = buildStatusBadge(a.submissionStatus);
    const typeBadge = a.assignmentType === 'quiz' ? '<span class="type-badge">Quiz</span>' : '';
    const hasDeepContent = a.fullInstructions || a.rubricText;
    const deepBadge = hasDeepContent ? '<span class="deep-badge">Full details</span>' : '';
    const gradeText = a.grade ? `<span class="grade-badge">${a.grade}</span>` : '';

    const titleHtml = a.assignmentUrl
      ? `<a href="${escapeHtml(a.assignmentUrl)}" target="_blank" rel="noopener">${escapeHtml(a.title)}</a>`
      : escapeHtml(a.title);

    const doneClass = isDone ? ' assignment-done' : '';

    return `
      <div class="assignment-card urgency-${a.urgency}${doneClass}">
        ${isDone ? '<div class="done-check">&#10003;</div>' : ''}
        <div class="assignment-info">
          <div class="assignment-title">${titleHtml} ${deepBadge}</div>
          <div class="assignment-meta">
            ${dueBadge}
            ${pointsText ? `<span>${pointsText}</span>` : ''}
            ${statusBadge}
            ${gradeText}
            ${typeBadge}
          </div>
        </div>
        <div class="assignment-actions">
          <button class="btn-help" data-assignment-id="${a.id}">
            Get help
          </button>
        </div>
      </div>
    `;
  }

  function buildDueBadge(dateStr, urgency, isDone) {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = date - now;
    const days = Math.ceil(diff / (1000 * 60 * 60 * 24));

    let text;
    if (isDone) {
      // For completed assignments, just show the date plainly
      text = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } else if (urgency === 'overdue') {
      text = `Overdue by ${Math.abs(days)} day${Math.abs(days) !== 1 ? 's' : ''}`;
    } else if (days === 0) {
      text = 'Due today';
    } else if (days === 1) {
      text = 'Due tomorrow';
    } else if (days < 7) {
      text = `Due in ${days} days`;
    } else {
      text = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    if (isDone) {
      return `<span class="due-badge">${text}</span>`;
    }

    const classMap = {
      overdue: 'due-overdue', due_today: 'due-today', due_soon: 'due-soon',
      this_week: 'due-week', upcoming: 'due-upcoming',
    };

    return `<span class="due-badge ${classMap[urgency] || ''}">${text}</span>`;
  }

  function buildStatusBadge(status) {
    const map = {
      not_submitted: '',
      submitted: '<span class="status-badge status-completed">Submitted</span>',
      graded: '<span class="status-badge status-completed">Graded</span>',
    };
    return map[status] || '';
  }

  // ─── Generation Modal ─────────────────────────────────────────────────────

  const genModal = document.getElementById('gen-modal');
  const genStepForm = document.getElementById('gen-step-form');
  const genStepProgress = document.getElementById('gen-step-progress');
  const genStepDone = document.getElementById('gen-step-done');
  const genStepError = document.getElementById('gen-step-error');

  let currentAssignment = null;
  let selectedOutputType = 'auto';

  function openGenModal(assignment) {
    currentAssignment = assignment;
    selectedOutputType = 'auto';

    // Reset to form step
    genStepForm.classList.remove('hidden');
    genStepProgress.classList.add('hidden');
    genStepDone.classList.add('hidden');
    genStepError.classList.add('hidden');

    // Fill in header
    document.getElementById('gen-modal-title').textContent = assignment.title;
    document.getElementById('gen-modal-course').textContent =
      assignment.courseCode
        ? `${assignment.courseCode} — ${assignment.courseName}`
        : assignment.courseName || '';

    // Due date
    const dueEl = document.getElementById('gen-modal-due');
    if (assignment.dueDate) {
      const date = new Date(assignment.dueDate);
      dueEl.textContent = 'Due ' + date.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
      });
      dueEl.style.display = '';
    } else {
      dueEl.style.display = 'none';
    }

    // Deep content preview — show structured sections
    const previewEl = document.getElementById('gen-deep-preview');
    const noContentEl = document.getElementById('gen-no-content');
    const instrSection = document.getElementById('gen-instructions-section');
    const rubricSection = document.getElementById('gen-rubric-section');
    const attachSection = document.getElementById('gen-attachments-section');

    const hasUsefulInstructions = assignment.fullInstructions &&
      !assignment.fullInstructions.toLowerCase().includes('no additional instructions') &&
      assignment.fullInstructions.length > 50;

    if (hasUsefulInstructions || assignment.rubricText) {
      previewEl.classList.remove('hidden');
      noContentEl.classList.add('hidden');

      if (hasUsefulInstructions) {
        instrSection.classList.remove('hidden');
        const instrText = assignment.fullInstructions.substring(0, 500);
        document.getElementById('gen-deep-instructions').textContent =
          instrText + (assignment.fullInstructions.length > 500 ? '...' : '');
      } else {
        instrSection.classList.add('hidden');
      }

      if (assignment.rubricText) {
        rubricSection.classList.remove('hidden');
        document.getElementById('gen-deep-rubric').textContent =
          assignment.rubricText.substring(0, 300) + (assignment.rubricText.length > 300 ? '...' : '');
      } else {
        rubricSection.classList.add('hidden');
      }

      if (assignment.attachmentNames) {
        try {
          const attachments = typeof assignment.attachmentNames === 'string'
            ? JSON.parse(assignment.attachmentNames) : assignment.attachmentNames;
          if (Array.isArray(attachments) && attachments.length > 0) {
            attachSection.classList.remove('hidden');
            document.getElementById('gen-deep-attachments').textContent = attachments.join(', ');
          } else {
            attachSection.classList.add('hidden');
          }
        } catch {
          attachSection.classList.add('hidden');
        }
      } else {
        attachSection.classList.add('hidden');
      }
    } else {
      previewEl.classList.add('hidden');
      noContentEl.classList.remove('hidden');
    }

    // Reset output type selection
    document.querySelectorAll('.gen-type-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.type === 'auto');
    });

    // Reset download buttons
    document.getElementById('gen-download-pptx').classList.add('hidden');
    document.getElementById('gen-download-docx').classList.add('hidden');

    genModal.classList.remove('hidden');
  }

  function closeGenModal() {
    genModal.classList.add('hidden');
    currentAssignment = null;
  }

  // Output type grid
  document.getElementById('gen-type-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('.gen-type-btn');
    if (!btn) return;
    document.querySelectorAll('.gen-type-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    selectedOutputType = btn.dataset.type;
  });

  // Close button
  document.getElementById('gen-modal-close').addEventListener('click', closeGenModal);

  // Click outside to close
  genModal.addEventListener('click', (e) => {
    if (e.target === genModal && genStepProgress.classList.contains('hidden')) {
      closeGenModal();
    }
  });

  // Generate button
  document.getElementById('gen-modal-generate').addEventListener('click', async () => {
    if (!currentAssignment) return;

    genStepForm.classList.add('hidden');
    genStepProgress.classList.remove('hidden');
    genStepDone.classList.add('hidden');
    genStepError.classList.add('hidden');

    const progressFill = document.getElementById('gen-progress-fill');
    const progressText = document.getElementById('gen-progress-text');
    progressFill.style.width = '10%';
    progressText.textContent = 'Analyzing assignment...';

    try {
      const { generationId } = await api.generate(
        null, 10, 'professional',
        currentAssignment.id,
        selectedOutputType
      );

      progressFill.style.width = '30%';
      progressText.textContent = 'Generating content...';

      const result = await pollGeneration(generationId, progressFill, progressText);

      genStepProgress.classList.add('hidden');
      genStepDone.classList.remove('hidden');

      const pptxBtn = document.getElementById('gen-download-pptx');
      const docxBtn = document.getElementById('gen-download-docx');

      if (result.has_pptx) {
        pptxBtn.classList.remove('hidden');
        pptxBtn.onclick = () => downloadFile(generationId, 'pptx');
      }
      if (result.has_docx) {
        docxBtn.classList.remove('hidden');
        docxBtn.onclick = () => downloadFile(generationId, 'docx');
      }
    } catch (err) {
      console.error('Generation error:', err);
      genStepProgress.classList.add('hidden');
      genStepError.classList.remove('hidden');
      document.getElementById('gen-error-text').textContent =
        err.message || 'Something went wrong. Please try again.';
    }
  });

  // Retry button
  document.getElementById('gen-retry-btn').addEventListener('click', () => {
    if (currentAssignment) openGenModal(currentAssignment);
  });

  async function pollGeneration(generationId, progressFill, progressText) {
    const stages = [
      { pct: '50%', text: 'Building document...' },
      { pct: '70%', text: 'Formatting output...' },
      { pct: '85%', text: 'Almost done...' },
    ];
    let stageIdx = 0;

    return new Promise((resolve, reject) => {
      const interval = setInterval(async () => {
        try {
          const status = await api.getGenerationStatus(generationId);

          if (status.status === 'completed') {
            clearInterval(interval);
            progressFill.style.width = '100%';
            progressText.textContent = 'Done!';
            setTimeout(() => resolve(status), 400);
          } else if (status.status === 'failed') {
            clearInterval(interval);
            reject(new Error('Generation failed. Please try again.'));
          } else {
            if (stageIdx < stages.length) {
              progressFill.style.width = stages[stageIdx].pct;
              progressText.textContent = stages[stageIdx].text;
              stageIdx++;
            }
          }
        } catch (err) {
          clearInterval(interval);
          reject(err);
        }
      }, 2000);
    });
  }

  function downloadFile(generationId, type) {
    const url = api.getDownloadUrl(generationId, type);
    const token = api.getToken();
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    fetch(url, { headers })
      .then((res) => {
        if (!res.ok) throw new Error('Download failed');
        return res.blob();
      })
      .then((blob) => {
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = `${currentAssignment ? currentAssignment.title : 'assignment'}.${type}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(blobUrl);
      })
      .catch((err) => {
        alert('Download failed: ' + err.message);
      });
  }

  // ─── Utility Functions ───────────────────────────────────────────────────

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatRelativeTime(date) {
    const now = new Date();
    const diff = now - date;
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
});
