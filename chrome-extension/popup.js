const API_BASE = 'https://backend-production-2c4d.up.railway.app';
const contentEl = document.getElementById('content');

// Check if current tab is a Brightspace page
chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
  if (!tab?.url) {
    showNotBrightspace();
    return;
  }

  // Detect Brightspace by URL patterns
  const isBrightspace = tab.url.includes('/d2l/') || tab.url.includes('brightspace');

  if (!isBrightspace) {
    showNotBrightspace();
    return;
  }

  showReady(tab);
});

function showNotBrightspace() {
  contentEl.innerHTML = `
    <div class="not-brightspace">
      <strong>Navigate to Brightspace first</strong>
      Open your university's Brightspace page, then click this extension to sync your assignments.
    </div>
  `;
}

function showReady(tab) {
  contentEl.innerHTML = `
    <div class="status">
      Brightspace detected. Click below to scan your courses and assignments.
    </div>
    <button id="sync-btn">Sync Assignments</button>
  `;

  document.getElementById('sync-btn').addEventListener('click', () => startSync(tab));
}

async function startSync(tab) {
  const btn = document.getElementById('sync-btn');
  btn.disabled = true;
  btn.textContent = 'Syncing...';

  contentEl.innerHTML = `
    <div class="status syncing" id="sync-status">
      Starting sync...
      <div class="progress-bar"><div class="progress-fill" id="progress" style="width: 5%"></div></div>
      <div class="detail" id="sync-detail"></div>
    </div>
    <button id="sync-btn" disabled>Syncing...</button>
  `;

  try {
    // Inject content script and run the scraper
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeAssignments,
      args: [tab.url],
    });

    const data = results[0]?.result;

    if (!data || data.error) {
      showError(data?.error || 'Failed to scrape assignments');
      return;
    }

    updateStatus('Sending to server...', 80);

    // Send to backend
    const res = await fetch(`${API_BASE}/tracker/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    const result = await res.json();

    if (!res.ok) {
      showError(result.error || 'Server error');
      return;
    }

    showSuccess(result);
  } catch (err) {
    showError(err.message);
  }
}

function updateStatus(text, pct) {
  const statusEl = document.getElementById('sync-status');
  const progressEl = document.getElementById('progress');
  if (statusEl) statusEl.firstChild.textContent = text;
  if (progressEl) progressEl.style.width = pct + '%';
}

function showError(msg) {
  contentEl.innerHTML = `
    <div class="status error">
      Sync failed: ${msg}
    </div>
    <button id="sync-btn" onclick="location.reload()">Try Again</button>
  `;
}

function showSuccess(result) {
  contentEl.innerHTML = `
    <div class="status success">
      Sync complete!
      <div class="detail">${result.coursesImported} courses, ${result.assignmentsImported} assignments imported</div>
    </div>
    <button id="sync-btn" onclick="location.reload()">Sync Again</button>
  `;
}

// ─── This function runs IN the Brightspace tab ──────────────────────────────

function scrapeAssignments(currentUrl) {
  return new Promise(async (resolve) => {
    try {
      const baseUrl = window.location.origin;

      // Step 1: Find courses
      const courses = [];
      const courseLinks = document.querySelectorAll('a[href*="/d2l/home/"]');

      const seen = new Set();
      courseLinks.forEach((link) => {
        const href = link.getAttribute('href');
        const match = href?.match(/\/d2l\/home\/(\d+)/);
        if (!match) return;

        const courseId = match[1];
        if (seen.has(courseId)) return;
        seen.add(courseId);

        const name = link.textContent.trim();
        if (!name || name.length < 2) return;

        // Extract course code (e.g., "CIS 101", "BIOL-2301")
        const codeMatch = name.match(/([A-Z]{2,5}[-\s]?\d{3,5})/i);

        courses.push({
          platformCourseId: courseId,
          name: name,
          courseCode: codeMatch ? codeMatch[1].trim() : null,
          url: `${baseUrl}/d2l/home/${courseId}`,
        });
      });

      // Also try course cards
      if (courses.length === 0) {
        const cards = document.querySelectorAll('.course-card, .d2l-card, [class*="enrollment-card"]');
        cards.forEach((card) => {
          const link = card.querySelector('a[href*="/d2l/home/"]');
          if (!link) return;
          const href = link.getAttribute('href');
          const match = href?.match(/\/d2l\/home\/(\d+)/);
          if (!match) return;
          const courseId = match[1];
          if (seen.has(courseId)) return;
          seen.add(courseId);
          const name = link.textContent.trim();
          const codeMatch = name.match(/([A-Z]{2,5}[-\s]?\d{3,5})/i);
          courses.push({
            platformCourseId: courseId,
            name,
            courseCode: codeMatch ? codeMatch[1].trim() : null,
            url: `${baseUrl}/d2l/home/${courseId}`,
          });
        });
      }

      if (courses.length === 0) {
        resolve({ error: 'No courses found. Make sure you are on your Brightspace homepage.' });
        return;
      }

      // Step 2: Fetch assignments for each course using the session cookies
      const allAssignments = [];

      for (const course of courses) {
        const courseId = course.platformCourseId;

        // Fetch dropbox/assignments page
        try {
          const resp = await fetch(`${baseUrl}/d2l/lms/dropbox/user/folders_list.d2l?ou=${courseId}&isprv=0`);
          const html = await resp.text();
          const doc = new DOMParser().parseFromString(html, 'text/html');

          // Parse assignment rows
          const rows = doc.querySelectorAll('.d2l-datalist-item, tr.d_ggl1, tr.d_ggl2, tr[class*="d2l"], .d2l-table-row');

          rows.forEach((row) => {
            const titleEl = row.querySelector('a, .d2l-heading, .d2l-textblock, th');
            if (!titleEl) return;
            const title = titleEl.textContent.trim();
            if (!title || title.length < 2) return;

            const href = titleEl.getAttribute('href');
            const rowText = row.textContent;

            // Extract due date
            let dueDate = null;
            const datePatterns = [
              /(?:due|deadline|closes)[:\s]*([A-Za-z]+ \d{1,2},? \d{4}(?:\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?)/i,
              /(\w{3}\s+\d{1,2},?\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)/i,
              /(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?)/,
            ];
            for (const pat of datePatterns) {
              const m = rowText.match(pat);
              if (m) {
                const d = new Date(m[1]);
                if (!isNaN(d.getTime()) && d.getFullYear() > 2020) {
                  dueDate = d.toISOString();
                  break;
                }
              }
            }

            // Extract points
            let points = null;
            const pointsMatch = rowText.match(/\/\s*(\d+(?:\.\d+)?)/);
            if (pointsMatch) points = parseFloat(pointsMatch[1]);

            // Infer status
            const lower = rowText.toLowerCase();
            let status = 'not_submitted';
            if (lower.includes('submitted') || lower.includes('completed')) status = 'submitted';
            else if (lower.includes('graded') || lower.includes('marked')) status = 'graded';

            const assignmentId = href?.match(/(?:db|fid)=(\d+)/)?.[1] ||
              `${courseId}_${title.slice(0, 30)}`;

            allAssignments.push({
              platformAssignmentId: assignmentId,
              courseId,
              title,
              dueDate,
              pointsPossible: points,
              submissionStatus: status,
              assignmentUrl: href ? `${baseUrl}${href}` : null,
              assignmentType: 'dropbox',
            });
          });

          // Fallback: broader link search
          if (allAssignments.filter((a) => a.courseId === courseId).length === 0) {
            const links = doc.querySelectorAll('a[href*="dropbox"][href*="folder"]');
            links.forEach((link) => {
              const text = link.textContent.trim();
              const lhref = link.getAttribute('href');
              if (text && text.length > 2) {
                allAssignments.push({
                  platformAssignmentId: lhref?.match(/db=(\d+)/)?.[1] || `${courseId}_${text.slice(0, 20)}`,
                  courseId,
                  title: text,
                  dueDate: null,
                  pointsPossible: null,
                  submissionStatus: 'not_submitted',
                  assignmentUrl: lhref ? `${baseUrl}${lhref}` : null,
                  assignmentType: 'dropbox',
                });
              }
            });
          }
        } catch (e) {
          console.warn(`Failed to fetch assignments for course ${courseId}:`, e);
        }

        // Fetch quizzes
        try {
          const resp = await fetch(`${baseUrl}/d2l/lms/quizzing/user/quizzes_list.d2l?ou=${courseId}`);
          const html = await resp.text();
          const doc = new DOMParser().parseFromString(html, 'text/html');

          const quizLinks = doc.querySelectorAll('a[href*="quiz"]');
          quizLinks.forEach((link) => {
            const text = link.textContent.trim();
            const href = link.getAttribute('href');
            if (text && text.length > 2 && href?.includes('qu=')) {
              const quizId = href.match(/qu=(\d+)/)?.[1];
              allAssignments.push({
                platformAssignmentId: quizId || `quiz_${courseId}_${text.slice(0, 20)}`,
                courseId,
                title: text,
                dueDate: null,
                pointsPossible: null,
                submissionStatus: 'not_submitted',
                assignmentUrl: href ? `${baseUrl}${href}` : null,
                assignmentType: 'quiz',
              });
            }
          });
        } catch (e) {
          // Quiz page may not exist
        }
      }

      resolve({
        lmsUrl: baseUrl,
        courses,
        assignments: allAssignments,
      });
    } catch (err) {
      resolve({ error: err.message });
    }
  });
}
