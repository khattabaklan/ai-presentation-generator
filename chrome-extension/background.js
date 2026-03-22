// ─── Deep Crawl Orchestrator ────────────────────────────────────────────────
// State machine that drives the multi-page Brightspace crawl.
// Survives across page navigations. Communicates with content.js on each page.

const API_BASE = 'https://backend-production-2c4d.up.railway.app';

let crawlState = {
  active: false,
  tabId: null,
  baseUrl: '',
  phase: 'idle',
  courses: [],
  currentCourseIndex: 0,
  assignments: [],
  currentAssignmentIndex: 0,
  results: {
    courses: [],
    assignments: [],
    quizzes: [],
    materials: [],
  },
  totalPages: 0,
  pagesCompleted: 0,
  error: null,
};

// ─── Message Handlers ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_DEEP_CRAWL') {
    startDeepCrawl(msg.tabId, msg.baseUrl);
    sendResponse({ started: true });
    return;
  }

  if (msg.type === 'GET_CRAWL_STATUS') {
    sendResponse({
      active: crawlState.active,
      phase: crawlState.phase,
      pagesCompleted: crawlState.pagesCompleted,
      totalPages: crawlState.totalPages,
      coursesFound: crawlState.results.courses.length,
      assignmentsFound: crawlState.results.assignments.length,
      currentCourse: getCurrentCourseName(),
      error: crawlState.error,
    });
    return;
  }

  if (msg.type === 'PAGE_READY' && crawlState.active && sender.tab?.id === crawlState.tabId) {
    // Content script loaded on the new page — tell it what to do
    console.log('[AA] PAGE_READY received, phase:', crawlState.phase);
    if (crawlState._readyTimeout) clearTimeout(crawlState._readyTimeout);
    setTimeout(() => handlePageReady(), 500);
    return;
  }

  if (msg.type === 'PAGE_DATA' && crawlState.active) {
    handlePageData(msg.payload);
    return;
  }

  if (msg.type === 'CANCEL_CRAWL') {
    cancelCrawl();
    sendResponse({ cancelled: true });
    return;
  }
});

// ─── Crawl Lifecycle ────────────────────────────────────────────────────────

function startDeepCrawl(tabId, url) {
  const baseUrl = new URL(url).origin;

  crawlState = {
    active: true,
    tabId,
    baseUrl,
    phase: 'courses',
    courses: [],
    currentCourseIndex: 0,
    assignments: [],
    currentAssignmentIndex: 0,
    results: { courses: [], assignments: [], quizzes: [], materials: [] },
    totalPages: 1, // at least the homepage
    pagesCompleted: 0,
    error: null,
  };

  broadcastProgress('Navigating to Brightspace homepage...');

  // Navigate to the homepage — force reload even if already on this page
  const targetUrl = `${baseUrl}/d2l/home`;
  chrome.tabs.get(tabId, (tab) => {
    if (tab.url && tab.url.replace(/[#?].*$/, '') === targetUrl) {
      // Already on the homepage — reload the tab to trigger content script
      chrome.tabs.reload(tabId);
      // Set fallback in case PAGE_READY doesn't arrive
      crawlState._readyTimeout = setTimeout(() => {
        if (!crawlState.active) return;
        console.log('[AA] Initial PAGE_READY timeout — injecting content script');
        chrome.scripting.executeScript({
          target: { tabId: crawlState.tabId },
          files: ['content.js'],
        }).then(() => {
          setTimeout(() => handlePageReady(), 1000);
        }).catch((err) => {
          console.error('[AA] Failed to inject:', err);
          crawlState.error = 'Could not connect to the page. Make sure you are on Brightspace.';
          crawlState.phase = 'error';
          crawlState.active = false;
          broadcastProgress('Error: Could not connect to the page');
        });
      }, 10000);
    } else {
      navigateWithFallback(targetUrl);
    }
  });
}

function cancelCrawl() {
  crawlState.active = false;
  crawlState.phase = 'idle';
  crawlState.error = 'Cancelled by user';
  broadcastProgress('Crawl cancelled');
}

function getCurrentCourseName() {
  if (crawlState.currentCourseIndex < crawlState.courses.length) {
    return crawlState.courses[crawlState.currentCourseIndex].name;
  }
  return '';
}

// ─── Page Ready Handler ─────────────────────────────────────────────────────

function handlePageReady() {
  if (!crawlState.active) return;

  // Tell content.js to scroll the page and extract text
  chrome.tabs.sendMessage(crawlState.tabId, {
    type: 'CRAWL_PAGE',
    pageType: crawlState.phase,
    progress: {
      phase: crawlState.phase,
      pagesCompleted: crawlState.pagesCompleted,
      totalPages: crawlState.totalPages,
      coursesFound: crawlState.results.courses.length,
      assignmentsFound: crawlState.results.assignments.length,
      currentCourse: getCurrentCourseName(),
    },
  });
}

// ─── Page Data Handler — The State Machine ──────────────────────────────────

async function handlePageData({ text, pageType }) {
  if (!crawlState.active) return;

  crawlState.pagesCompleted++;

  try {
    // Send page text to backend for Claude parsing
    broadcastProgress(`Claude is analyzing the page...`);
    const parsed = await callBackend('/tracker/parse-page', { text, pageType, courseId: getCurrentCourseId() });

    // Advance the state machine based on current phase
    switch (crawlState.phase) {
      case 'courses':
        await handleCoursesResult(parsed);
        break;
      case 'assignments_list':
        await handleAssignmentsListResult(parsed);
        break;
      case 'assignment_detail':
        await handleAssignmentDetailResult(parsed);
        break;
      case 'quizzes':
        await handleQuizzesResult(parsed);
        break;
      case 'course_content':
        await handleCourseContentResult(parsed);
        break;
    }
  } catch (err) {
    console.error('Crawl step error:', err);
    // Skip this step and try to continue
    advanceToNextStep();
  }
}

// ─── State Handlers ─────────────────────────────────────────────────────────

async function handleCoursesResult(parsed) {
  crawlState.courses = parsed.courses || [];
  crawlState.results.courses = crawlState.courses;

  if (crawlState.courses.length === 0) {
    finishCrawl('No courses found');
    return;
  }

  // Calculate total pages: for each course = 1 (assignments list) + N (details) + 1 (quizzes) + 1 (content)
  // We estimate 5 assignments per course for now, will adjust after getting the list
  crawlState.totalPages = 1 + crawlState.courses.length * 8;

  broadcastProgress(`Found ${crawlState.courses.length} courses. Starting deep scan...`);

  // Start with first course's assignment list
  crawlState.currentCourseIndex = 0;
  crawlState.phase = 'assignments_list';
  navigateToAssignmentsList();
}

async function handleAssignmentsListResult(parsed) {
  crawlState.assignments = parsed.assignments || [];
  const courseId = getCurrentCourseId();

  // Store basic assignment info (will be enriched with detail crawl)
  for (const a of crawlState.assignments) {
    a.courseId = courseId;
    a.assignmentType = 'dropbox';
  }

  // Recalculate total pages now that we know assignment count
  const remainingCourses = crawlState.courses.length - crawlState.currentCourseIndex - 1;
  crawlState.totalPages = crawlState.pagesCompleted + crawlState.assignments.length + 2 + (remainingCourses * 8);

  if (crawlState.assignments.length > 0 && crawlState.assignments[0].detailUrl) {
    broadcastProgress(`Found ${crawlState.assignments.length} assignments. Reading details...`);
    crawlState.currentAssignmentIndex = 0;
    crawlState.phase = 'assignment_detail';
    navigateToAssignmentDetail();
  } else {
    // No detail URLs — skip to quizzes
    crawlState.results.assignments.push(...crawlState.assignments);
    crawlState.phase = 'quizzes';
    navigateToQuizzes();
  }
}

async function handleAssignmentDetailResult(parsed) {
  const assignment = crawlState.assignments[crawlState.currentAssignmentIndex];
  if (assignment && parsed) {
    assignment.fullInstructions = parsed.fullInstructions || null;
    assignment.rubric = parsed.rubric || null;
    assignment.requirements = parsed.requirements || [];
    assignment.attachments = parsed.attachments || [];
  }

  crawlState.currentAssignmentIndex++;

  if (crawlState.currentAssignmentIndex < crawlState.assignments.length) {
    const next = crawlState.assignments[crawlState.currentAssignmentIndex];
    if (next.detailUrl) {
      broadcastProgress(`Reading assignment ${crawlState.currentAssignmentIndex + 1}/${crawlState.assignments.length}...`);
      navigateToAssignmentDetail();
    } else {
      // Skip assignments without detail URLs
      handleAssignmentDetailResult(null);
    }
  } else {
    // Done with assignment details for this course
    crawlState.results.assignments.push(...crawlState.assignments);

    // Save progress after each course's assignments
    await saveProgressToBackend();

    crawlState.phase = 'quizzes';
    navigateToQuizzes();
  }
}

async function handleQuizzesResult(parsed) {
  const courseId = getCurrentCourseId();
  const quizzes = (parsed.quizzes || []).map(q => ({ ...q, courseId }));
  crawlState.results.quizzes.push(...quizzes);

  crawlState.phase = 'course_content';
  navigateToCourseContent();
}

async function handleCourseContentResult(parsed) {
  const courseId = getCurrentCourseId();
  const materials = (parsed.materials || []).map(m => ({ ...m, courseId }));
  crawlState.results.materials.push(...materials);

  // Move to next course
  crawlState.currentCourseIndex++;

  if (crawlState.currentCourseIndex < crawlState.courses.length) {
    broadcastProgress(`Moving to course ${crawlState.currentCourseIndex + 1}/${crawlState.courses.length}...`);
    crawlState.phase = 'assignments_list';
    crawlState.assignments = [];
    crawlState.currentAssignmentIndex = 0;
    navigateToAssignmentsList();
  } else {
    await finishCrawl();
  }
}

function advanceToNextStep() {
  // Emergency skip — try to continue the crawl
  switch (crawlState.phase) {
    case 'courses':
      finishCrawl('Failed to find courses');
      break;
    case 'assignments_list':
      crawlState.phase = 'quizzes';
      navigateToQuizzes();
      break;
    case 'assignment_detail':
      crawlState.currentAssignmentIndex++;
      if (crawlState.currentAssignmentIndex < crawlState.assignments.length) {
        navigateToAssignmentDetail();
      } else {
        crawlState.results.assignments.push(...crawlState.assignments);
        crawlState.phase = 'quizzes';
        navigateToQuizzes();
      }
      break;
    case 'quizzes':
      crawlState.phase = 'course_content';
      navigateToCourseContent();
      break;
    case 'course_content':
      crawlState.currentCourseIndex++;
      if (crawlState.currentCourseIndex < crawlState.courses.length) {
        crawlState.phase = 'assignments_list';
        navigateToAssignmentsList();
      } else {
        finishCrawl();
      }
      break;
  }
}

// ─── Navigation Helpers ─────────────────────────────────────────────────────

// Navigate and set a fallback: if PAGE_READY doesn't arrive in 15s, try sending CRAWL_PAGE directly
function navigateWithFallback(url) {
  console.log('[AA] Navigating to:', url);
  if (crawlState._readyTimeout) clearTimeout(crawlState._readyTimeout);

  chrome.tabs.update(crawlState.tabId, { url });

  crawlState._readyTimeout = setTimeout(() => {
    if (!crawlState.active) return;
    console.log('[AA] PAGE_READY timeout — trying to inject content script and send CRAWL_PAGE directly');
    // Try injecting the content script manually in case it didn't auto-inject
    chrome.scripting.executeScript({
      target: { tabId: crawlState.tabId },
      files: ['content.js'],
    }).then(() => {
      setTimeout(() => handlePageReady(), 1000);
    }).catch((err) => {
      console.error('[AA] Failed to inject content script:', err);
      advanceToNextStep();
    });
  }, 15000);
}

function getCurrentCourseId() {
  if (crawlState.currentCourseIndex < crawlState.courses.length) {
    return crawlState.courses[crawlState.currentCourseIndex].courseId;
  }
  return null;
}

function navigateToAssignmentsList() {
  const courseId = getCurrentCourseId();
  const courseName = getCurrentCourseName();
  broadcastProgress(`Scanning assignments for ${courseName}...`);
  navigateWithFallback(`${crawlState.baseUrl}/d2l/lms/dropbox/user/folders_list.d2l?ou=${courseId}&isprv=0`);
}

function navigateToAssignmentDetail() {
  const assignment = crawlState.assignments[crawlState.currentAssignmentIndex];
  if (!assignment?.detailUrl) {
    advanceToNextStep();
    return;
  }

  const url = assignment.detailUrl.startsWith('http')
    ? assignment.detailUrl
    : `${crawlState.baseUrl}${assignment.detailUrl}`;

  broadcastProgress(`Reading: ${assignment.title}...`);
  navigateWithFallback(url);
}

function navigateToQuizzes() {
  const courseId = getCurrentCourseId();
  broadcastProgress(`Scanning quizzes for ${getCurrentCourseName()}...`);
  navigateWithFallback(`${crawlState.baseUrl}/d2l/lms/quizzing/user/quizzes_list.d2l?ou=${courseId}`);
}

function navigateToCourseContent() {
  const courseId = getCurrentCourseId();
  broadcastProgress(`Reading course materials for ${getCurrentCourseName()}...`);
  navigateWithFallback(`${crawlState.baseUrl}/d2l/le/content/${courseId}/Home`);
}

// ─── Finish & Save ──────────────────────────────────────────────────────────

async function saveProgressToBackend() {
  try {
    await callBackend('/tracker/deep-import', crawlState.results);
  } catch (err) {
    console.error('Save progress error:', err);
  }
}

async function finishCrawl(errorMsg) {
  crawlState.active = false;

  if (errorMsg) {
    crawlState.error = errorMsg;
    crawlState.phase = 'error';
    broadcastProgress(`Error: ${errorMsg}`);
    return;
  }

  // Final save
  try {
    broadcastProgress('Saving all data...');
    await callBackend('/tracker/deep-import', crawlState.results);
    crawlState.phase = 'done';
    broadcastProgress('Deep crawl complete!');
  } catch (err) {
    console.error('Final save error:', err);
    crawlState.error = 'Failed to save results';
    crawlState.phase = 'error';
    broadcastProgress('Error saving results');
  }

  // Notify content script to show completion
  try {
    chrome.tabs.sendMessage(crawlState.tabId, {
      type: 'CRAWL_COMPLETE',
      results: {
        courses: crawlState.results.courses.length,
        assignments: crawlState.results.assignments.length,
        quizzes: crawlState.results.quizzes.length,
        materials: crawlState.results.materials.reduce((sum, m) => sum + (m.topics?.length || 0), 0),
      },
    });
  } catch (e) {
    // Tab may have been closed
  }
}

// ─── Backend API Calls ──────────────────────────────────────────────────────

async function callBackend(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Backend request failed');
  return data;
}

// ─── Progress Broadcasting ──────────────────────────────────────────────────

function broadcastProgress(message) {
  const status = {
    type: 'CRAWL_PROGRESS',
    active: crawlState.active,
    phase: crawlState.phase,
    message,
    pagesCompleted: crawlState.pagesCompleted,
    totalPages: crawlState.totalPages,
    coursesFound: crawlState.results.courses.length,
    assignmentsFound: crawlState.results.assignments.length,
    currentCourse: getCurrentCourseName(),
  };

  // Send to popup (if open)
  chrome.runtime.sendMessage(status).catch(() => {});

  // Send to content script (for overlay)
  if (crawlState.tabId) {
    chrome.tabs.sendMessage(crawlState.tabId, status).catch(() => {});
  }
}
