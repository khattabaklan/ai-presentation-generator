// ─── Deep Crawl Orchestrator ────────────────────────────────────────────────
// Clicks through Brightspace like a student: opens each course, clicks Content,
// Assignments, Quizzes — reads everything. Survives page navigations.

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
  _readyTimeout: null,
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
    console.log('[AA] PAGE_READY from:', sender.tab.url);
    if (crawlState._readyTimeout) clearTimeout(crawlState._readyTimeout);
    const tabUrl = sender.tab.url || '';
    setTimeout(() => onPageReady(tabUrl), 500);
    return;
  }

  if (msg.type === 'PAGE_DATA' && crawlState.active) {
    console.log('[AA] PAGE_DATA:', msg.payload?.pageType, 'direct:', !!msg.payload?.directData);
    handlePageData(msg.payload);
    return;
  }

  if (msg.type === 'NAVIGATE_FALLBACK' && crawlState.active) {
    console.log('[AA] Navigate fallback to:', msg.url);
    chrome.tabs.update(crawlState.tabId, { url: msg.url });
    return;
  }

  if (msg.type === 'NAV_NOT_FOUND' && crawlState.active) {
    console.log('[AA] Nav not found:', msg.target, '— using URL fallback');
    navigateByUrl(msg.target);
    return;
  }

  if (msg.type === 'CLICK_FAILED' && crawlState.active) {
    console.log('[AA] Click failed:', msg.reason, '— skipping');
    advanceToNextStep();
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
    phase: 'extract_courses',
    courses: [],
    currentCourseIndex: 0,
    assignments: [],
    currentAssignmentIndex: 0,
    results: { courses: [], assignments: [], quizzes: [], materials: [] },
    totalPages: 1,
    pagesCompleted: 0,
    error: null,
    _readyTimeout: null,
  };

  // Detect where the user already is
  chrome.tabs.get(tabId, (tab) => {
    const currentUrl = tab.url || '';
    const isHomepage = /\/d2l\/home\/?$/.test(currentUrl) || currentUrl.endsWith('/d2l/home');
    const courseMatch = currentUrl.match(/\/d2l\/home\/(\d+)/);

    if (isHomepage) {
      // Already on homepage — just reload to trigger content script
      broadcastProgress('Scanning your courses...');
      chrome.tabs.reload(tabId);
    } else if (courseMatch) {
      // User is already inside a course — skip course finding, scan this course
      broadcastProgress('Already in a course! Scanning it...');
      const courseId = courseMatch[1];
      const pageName = tab.title || 'Current Course';
      crawlState.courses = [{ courseId, name: pageName, code: null, url: currentUrl }];
      crawlState.results.courses = crawlState.courses;
      crawlState.currentCourseIndex = 0;
      crawlState.totalPages = 9;
      crawlState.phase = 'click_content';
      chrome.tabs.reload(tabId);
    } else {
      // On some other Brightspace page — go to homepage
      broadcastProgress('Going to Brightspace homepage...');
      chrome.tabs.update(tabId, { url: `${baseUrl}/d2l/home` });
    }
    setReadyTimeout();
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

function getCurrentCourseId() {
  if (crawlState.currentCourseIndex < crawlState.courses.length) {
    return crawlState.courses[crawlState.currentCourseIndex].courseId;
  }
  return null;
}

// ─── Page Ready — Dispatch Action Based on Phase ────────────────────────────

function onPageReady(tabUrl = '') {
  if (!crawlState.active) return;
  console.log('[AA] onPageReady, phase:', crawlState.phase, 'url:', tabUrl);

  const progress = {
    phase: crawlState.phase,
    pagesCompleted: crawlState.pagesCompleted,
    totalPages: crawlState.totalPages,
    coursesFound: crawlState.results.courses.length,
    assignmentsFound: crawlState.results.assignments.length,
    currentCourse: getCurrentCourseName(),
  };

  // Map phases to content.js actions
  switch (crawlState.phase) {
    case 'extract_courses':
      sendAction('extract_courses', progress);
      break;

    case 'click_course':
      // Check if we've already navigated to the course page (PAGE_READY after click)
      if (tabUrl.includes(`/d2l/home/${getCurrentCourseId()}`)) {
        // We're on the course home — move to content
        crawlState.phase = 'click_content';
        broadcastProgress(`Inside ${getCurrentCourseName()}. Clicking Content...`);
        sendAction('click_nav', progress, { target: 'content' });
      } else {
        // Still on homepage — click the course card
        sendAction('click_course', progress, { courseId: getCurrentCourseId() });
      }
      break;

    case 'click_content':
      // After clicking Content, we land on the content page — read it
      crawlState.phase = 'read_content';
      sendAction('read_page', progress, { pageType: 'course_content' });
      break;

    case 'read_content':
      sendAction('read_page', progress, { pageType: 'course_content' });
      break;

    case 'click_assignments':
      // After clicking Assignments, we land on the assignments list — read it
      crawlState.phase = 'read_assignments';
      sendAction('read_page', progress, { pageType: 'assignments_list' });
      break;

    case 'read_assignments':
      sendAction('read_page', progress, { pageType: 'assignments_list' });
      break;

    case 'click_assignment_detail': {
      // After clicking an assignment link, we land on detail page — read it
      crawlState.phase = 'read_assignment_detail';
      sendAction('read_page', progress, { pageType: 'assignment_detail' });
      break;
    }

    case 'read_assignment_detail':
      sendAction('read_page', progress, { pageType: 'assignment_detail' });
      break;

    case 'click_quizzes':
      // After clicking Quizzes, we land on quizzes page — read it
      crawlState.phase = 'read_quizzes';
      sendAction('read_page', progress, { pageType: 'quizzes' });
      break;

    case 'read_quizzes':
      sendAction('read_page', progress, { pageType: 'quizzes' });
      break;

    default:
      console.log('[AA] Unknown phase:', crawlState.phase);
  }
}

function sendAction(action, progress, data = {}) {
  chrome.tabs.sendMessage(crawlState.tabId, {
    type: 'CRAWL_ACTION',
    action,
    progress,
    data,
  }).catch((err) => {
    console.error('[AA] Failed to send action:', err);
    // Try injecting content script
    chrome.scripting.executeScript({
      target: { tabId: crawlState.tabId },
      files: ['content.js'],
    }).then(() => {
      setTimeout(() => {
        chrome.tabs.sendMessage(crawlState.tabId, { type: 'CRAWL_ACTION', action, progress, data }).catch(() => {
          advanceToNextStep();
        });
      }, 1000);
    }).catch(() => advanceToNextStep());
  });
}

// ─── Page Data Handler — Advance the State Machine ──────────────────────────

async function handlePageData({ text, pageType, directData }) {
  if (!crawlState.active) return;

  crawlState.pagesCompleted++;

  try {
    let parsed;

    if (directData) {
      parsed = directData;
    } else {
      broadcastProgress('Claude is reading the page...');
      parsed = await callBackend('/tracker/parse-page', { text, pageType, courseId: getCurrentCourseId() });
    }

    // Advance based on what we just received
    switch (pageType || crawlState.phase) {
      case 'courses':
        handleCoursesResult(parsed);
        break;
      case 'course_content':
        handleContentResult(parsed);
        break;
      case 'assignments_list':
        handleAssignmentsListResult(parsed);
        break;
      case 'assignment_detail':
        handleAssignmentDetailResult(parsed);
        break;
      case 'quizzes':
        handleQuizzesResult(parsed);
        break;
    }
  } catch (err) {
    console.error('[AA] Crawl step error:', err);
    advanceToNextStep();
  }
}

// ─── State Handlers ─────────────────────────────────────────────────────────

function handleCoursesResult(parsed) {
  crawlState.courses = parsed.courses || [];
  crawlState.results.courses = crawlState.courses;

  if (crawlState.courses.length === 0) {
    finishCrawl('No courses found');
    return;
  }

  // Estimate total: per course = click in + content + assignments list + ~5 details + quizzes = ~9 pages
  crawlState.totalPages = 1 + crawlState.courses.length * 9;

  broadcastProgress(`Found ${crawlState.courses.length} courses! Clicking into first course...`);

  // Start: click into the first course
  crawlState.currentCourseIndex = 0;
  crawlState.phase = 'click_course';

  // Send click action to content.js (we're still on homepage)
  onPageReady();
}

function handleContentResult(parsed) {
  const courseId = getCurrentCourseId();
  const materials = (parsed.materials || []).map((m) => ({ ...m, courseId }));
  crawlState.results.materials.push(...materials);

  broadcastProgress(`Found ${materials.length} modules. Now checking assignments...`);

  // Next: click Assignments nav link
  crawlState.phase = 'click_assignments';

  // We need to go back to course home to find the nav link
  // Navigate to course home, then onPageReady will click Assignments
  const courseHomeUrl = `${crawlState.baseUrl}/d2l/home/${courseId}`;
  chrome.tabs.update(crawlState.tabId, { url: courseHomeUrl });
  setReadyTimeout();
}

function handleAssignmentsListResult(parsed) {
  crawlState.assignments = parsed.assignments || [];
  const courseId = getCurrentCourseId();

  for (const a of crawlState.assignments) {
    a.courseId = courseId;
    a.assignmentType = 'dropbox';
  }

  // Recalculate total pages
  const remainingCourses = crawlState.courses.length - crawlState.currentCourseIndex - 1;
  crawlState.totalPages = crawlState.pagesCompleted + crawlState.assignments.length + 2 + remainingCourses * 9;

  if (crawlState.assignments.length > 0 && crawlState.assignments[0].detailUrl) {
    broadcastProgress(`Found ${crawlState.assignments.length} assignments. Clicking into each one...`);
    crawlState.currentAssignmentIndex = 0;
    crawlState.phase = 'click_assignment_detail';

    // Navigate back to assignments list to click the first one
    navigateByUrl('assignments');
    setReadyTimeout();
  } else if (crawlState.assignments.length > 0) {
    // No detail URLs — save what we have and move to quizzes
    broadcastProgress(`Found ${crawlState.assignments.length} assignments. Checking quizzes...`);
    crawlState.results.assignments.push(...crawlState.assignments);
    crawlState.phase = 'click_quizzes';

    // Go back to course home to click Quizzes
    chrome.tabs.update(crawlState.tabId, { url: `${crawlState.baseUrl}/d2l/home/${courseId}` });
    setReadyTimeout();
  } else {
    broadcastProgress('No assignments found. Checking quizzes...');
    crawlState.phase = 'click_quizzes';
    chrome.tabs.update(crawlState.tabId, { url: `${crawlState.baseUrl}/d2l/home/${courseId}` });
    setReadyTimeout();
  }
}

function handleAssignmentDetailResult(parsed) {
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

      // Navigate back to assignments list to click the next one
      crawlState.phase = 'click_assignment_detail';
      navigateByUrl('assignments');
      setReadyTimeout();
    } else {
      handleAssignmentDetailResult(null);
    }
  } else {
    // Done with assignment details
    crawlState.results.assignments.push(...crawlState.assignments);
    saveProgressToBackend();

    // Move to quizzes
    broadcastProgress('Done with assignments. Checking quizzes...');
    crawlState.phase = 'click_quizzes';
    const courseId = getCurrentCourseId();
    chrome.tabs.update(crawlState.tabId, { url: `${crawlState.baseUrl}/d2l/home/${courseId}` });
    setReadyTimeout();
  }
}

function handleQuizzesResult(parsed) {
  const courseId = getCurrentCourseId();
  const quizzes = (parsed.quizzes || []).map((q) => ({ ...q, courseId }));
  crawlState.results.quizzes.push(...quizzes);

  broadcastProgress(`Found ${quizzes.length} quizzes.`);

  // Move to next course
  moveToNextCourse();
}

function moveToNextCourse() {
  crawlState.currentCourseIndex++;

  if (crawlState.currentCourseIndex < crawlState.courses.length) {
    const name = getCurrentCourseName();
    broadcastProgress(`Moving to next course: ${name}...`);

    crawlState.assignments = [];
    crawlState.currentAssignmentIndex = 0;

    // Go back to homepage to click the next course
    crawlState.phase = 'click_course';
    chrome.tabs.update(crawlState.tabId, { url: `${crawlState.baseUrl}/d2l/home` });
    setReadyTimeout();
  } else {
    finishCrawl();
  }
}

function advanceToNextStep() {
  console.log('[AA] advanceToNextStep, current phase:', crawlState.phase);

  switch (crawlState.phase) {
    case 'extract_courses':
      finishCrawl('Failed to find courses');
      break;
    case 'click_course':
    case 'click_content':
    case 'read_content':
      // Skip content, try assignments
      crawlState.phase = 'click_assignments';
      chrome.tabs.update(crawlState.tabId, { url: `${crawlState.baseUrl}/d2l/home/${getCurrentCourseId()}` });
      setReadyTimeout();
      break;
    case 'click_assignments':
    case 'read_assignments':
      // Skip assignments, try quizzes
      crawlState.phase = 'click_quizzes';
      chrome.tabs.update(crawlState.tabId, { url: `${crawlState.baseUrl}/d2l/home/${getCurrentCourseId()}` });
      setReadyTimeout();
      break;
    case 'click_assignment_detail':
    case 'read_assignment_detail':
      crawlState.currentAssignmentIndex++;
      if (crawlState.currentAssignmentIndex < crawlState.assignments.length) {
        crawlState.phase = 'click_assignment_detail';
        navigateByUrl('assignments');
        setReadyTimeout();
      } else {
        crawlState.results.assignments.push(...crawlState.assignments);
        crawlState.phase = 'click_quizzes';
        chrome.tabs.update(crawlState.tabId, { url: `${crawlState.baseUrl}/d2l/home/${getCurrentCourseId()}` });
        setReadyTimeout();
      }
      break;
    case 'click_quizzes':
    case 'read_quizzes':
      // Skip quizzes, move to next course
      moveToNextCourse();
      break;
    default:
      finishCrawl();
  }
}

// ─── URL Fallback Navigation ────────────────────────────────────────────────
// When clicking nav links fails, navigate by URL directly

function navigateByUrl(target) {
  const courseId = getCurrentCourseId();
  const urls = {
    content: `${crawlState.baseUrl}/d2l/le/content/${courseId}/Home`,
    assignments: `${crawlState.baseUrl}/d2l/lms/dropbox/user/folders_list.d2l?ou=${courseId}&isprv=0`,
    quizzes: `${crawlState.baseUrl}/d2l/lms/quizzing/user/quizzes_list.d2l?ou=${courseId}`,
  };

  if (urls[target]) {
    chrome.tabs.update(crawlState.tabId, { url: urls[target] });
  }
}

// ─── Ready Timeout ──────────────────────────────────────────────────────────
// If PAGE_READY doesn't arrive in 15s, try injecting content script

function setReadyTimeout() {
  if (crawlState._readyTimeout) clearTimeout(crawlState._readyTimeout);

  crawlState._readyTimeout = setTimeout(() => {
    if (!crawlState.active) return;
    console.log('[AA] PAGE_READY timeout — injecting content script');

    chrome.scripting.executeScript({
      target: { tabId: crawlState.tabId },
      files: ['content.js'],
    }).then(() => {
      setTimeout(() => onPageReady(), 1000);
    }).catch((err) => {
      console.error('[AA] Inject failed:', err);
      advanceToNextStep();
    });
  }, 15000);
}

// ─── Finish & Save ──────────────────────────────────────────────────────────

async function saveProgressToBackend() {
  try {
    await callBackend('/tracker/deep-import', crawlState.results);
  } catch (err) {
    console.error('[AA] Save progress error:', err);
  }
}

async function finishCrawl(errorMsg) {
  crawlState.active = false;
  if (crawlState._readyTimeout) clearTimeout(crawlState._readyTimeout);

  if (errorMsg) {
    crawlState.error = errorMsg;
    crawlState.phase = 'error';
    broadcastProgress(`Error: ${errorMsg}`);
    return;
  }

  try {
    broadcastProgress('Saving everything to Academic Assistant...');
    await callBackend('/tracker/deep-import', crawlState.results);
    crawlState.phase = 'done';
    broadcastProgress('Deep scan complete!');
  } catch (err) {
    console.error('[AA] Final save error:', err);
    crawlState.error = 'Failed to save results';
    crawlState.phase = 'error';
    broadcastProgress('Error saving results');
  }

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
  } catch (e) {}
}

// ─── Backend API ────────────────────────────────────────────────────────────

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

  chrome.runtime.sendMessage(status).catch(() => {});

  if (crawlState.tabId) {
    chrome.tabs.sendMessage(crawlState.tabId, status).catch(() => {});
  }
}
