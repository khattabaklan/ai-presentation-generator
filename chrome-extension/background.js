// ─── Deep Crawl Orchestrator ────────────────────────────────────────────────
// Navigates through every section of every Brightspace course:
// Course Home → Content → Assignments → each Assignment Detail → Quizzes
// The student watches it scroll through and read each page.

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
  results: { courses: [], assignments: [], quizzes: [], materials: [] },
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
    console.log('[AA] PAGE_READY, phase:', crawlState.phase, 'url:', sender.tab.url);
    if (crawlState._readyTimeout) clearTimeout(crawlState._readyTimeout);
    setTimeout(() => onPageReady(), 600);
    return;
  }

  if (msg.type === 'PAGE_DATA' && crawlState.active) {
    console.log('[AA] PAGE_DATA:', msg.payload?.pageType, 'direct:', !!msg.payload?.directData);
    handlePageData(msg.payload);
    return;
  }

  if (msg.type === 'CANCEL_CRAWL') {
    cancelCrawl();
    sendResponse({ cancelled: true });
    return;
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function getCurrentCourseName() {
  const c = crawlState.courses[crawlState.currentCourseIndex];
  return c ? c.name : '';
}

function getCurrentCourseId() {
  const c = crawlState.courses[crawlState.currentCourseIndex];
  return c ? c.courseId : null;
}

function cancelCrawl() {
  crawlState.active = false;
  crawlState.phase = 'idle';
  if (crawlState._readyTimeout) clearTimeout(crawlState._readyTimeout);
  broadcastProgress('Crawl cancelled');
}

// ─── Start Crawl ────────────────────────────────────────────────────────────

function startDeepCrawl(tabId, url) {
  if (crawlState.active) return; // Guard against double-start

  const baseUrl = new URL(url).origin;

  crawlState = {
    active: true, tabId, baseUrl,
    phase: 'find_courses',
    courses: [], currentCourseIndex: 0,
    assignments: [], currentAssignmentIndex: 0,
    results: { courses: [], assignments: [], quizzes: [], materials: [] },
    totalPages: 1, pagesCompleted: 0,
    error: null, _readyTimeout: null,
  };

  // Check if user is already inside a course
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError) {
      console.error('[AA] tabs.get error:', chrome.runtime.lastError);
      cancelCrawl();
      return;
    }
    const courseMatch = (tab.url || '').match(/\/d2l\/home\/(\d+)/);

    if (courseMatch) {
      // Already in a course — scan just this one
      const courseId = courseMatch[1];
      crawlState.courses = [{ courseId, name: tab.title || `Course ${courseId}`, code: null }];
      crawlState.results.courses = crawlState.courses;
      crawlState.totalPages = 5;
      crawlState.phase = 'go_content';
      broadcastProgress(`Scanning ${crawlState.courses[0].name}...`);
      goToUrl(`${baseUrl}/d2l/le/content/${courseId}/Home`);
    } else {
      // Go to or stay on homepage to find courses
      broadcastProgress('Finding your courses...');
      const homepageUrl = `${baseUrl}/d2l/home`;
      if ((tab.url || '').replace(/[#?].*$/, '').endsWith('/d2l/home')) {
        chrome.tabs.reload(tabId);
      } else {
        chrome.tabs.update(tabId, { url: homepageUrl });
      }
      setReadyTimeout();
    }
  });
}

// ─── Navigate by URL ────────────────────────────────────────────────────────

function goToUrl(url) {
  console.log('[AA] Navigating to:', url);
  chrome.tabs.update(crawlState.tabId, { url });
  setReadyTimeout();
}

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
      skipCurrentStep();
    });
  }, 15000);
}

// ─── Page Ready — Tell Content Script What To Do ────────────────────────────

function onPageReady() {
  if (!crawlState.active) return;

  const progress = {
    pagesCompleted: crawlState.pagesCompleted,
    totalPages: crawlState.totalPages,
    coursesFound: crawlState.results.courses.length,
    assignmentsFound: crawlState.results.assignments.length,
    currentCourse: getCurrentCourseName(),
  };

  console.log('[AA] onPageReady, phase:', crawlState.phase);

  switch (crawlState.phase) {
    case 'find_courses':
      sendAction('extract_courses', progress);
      break;

    case 'go_content':
      broadcastProgress(`Reading content for ${getCurrentCourseName()}...`);
      sendAction('read_page', progress, { pageType: 'course_content' });
      break;

    case 'go_assignments':
      broadcastProgress(`Reading assignments for ${getCurrentCourseName()}...`);
      sendAction('read_page', progress, { pageType: 'assignments_list' });
      break;

    case 'go_assignment_detail':
      const a = crawlState.assignments[crawlState.currentAssignmentIndex];
      broadcastProgress(`Reading: ${a?.title || 'assignment'}...`);
      sendAction('read_page', progress, { pageType: 'assignment_detail' });
      break;

    case 'go_quizzes':
      broadcastProgress(`Reading quizzes for ${getCurrentCourseName()}...`);
      sendAction('read_page', progress, { pageType: 'quizzes' });
      break;

    default:
      console.log('[AA] Unhandled phase in onPageReady:', crawlState.phase);
  }
}

function sendAction(action, progress, data = {}) {
  chrome.tabs.sendMessage(crawlState.tabId, {
    type: 'CRAWL_ACTION',
    action,
    progress,
    data,
  }).catch((err) => {
    console.error('[AA] sendAction failed:', err);
    chrome.scripting.executeScript({
      target: { tabId: crawlState.tabId },
      files: ['content.js'],
    }).then(() => {
      setTimeout(() => {
        chrome.tabs.sendMessage(crawlState.tabId, { type: 'CRAWL_ACTION', action, progress, data }).catch(() => skipCurrentStep());
      }, 1500);
    }).catch(() => skipCurrentStep());
  });
}

// ─── Handle Page Data — The State Machine ───────────────────────────────────

async function handlePageData({ text, pageType, directData }) {
  if (!crawlState.active) return;
  crawlState.pagesCompleted++;

  try {
    let parsed;
    if (directData) {
      parsed = directData;
    } else {
      broadcastProgress('Claude is analyzing the page...');
      parsed = await callBackend('/tracker/parse-page', { text, pageType, courseId: getCurrentCourseId() });
    }

    switch (pageType) {
      case 'courses':       onCoursesParsed(parsed); break;
      case 'course_content': onContentParsed(parsed); break;
      case 'assignments_list': onAssignmentListParsed(parsed); break;
      case 'assignment_detail': onAssignmentDetailParsed(parsed); break;
      case 'quizzes':       onQuizzesParsed(parsed); break;
    }
  } catch (err) {
    console.error('[AA] Parse error:', err);
    skipCurrentStep();
  }
}

// ─── Phase Transitions ─────────────────────────────────────────────────────

function onCoursesParsed(parsed) {
  crawlState.courses = parsed.courses || [];
  crawlState.results.courses = crawlState.courses;

  if (crawlState.courses.length === 0) {
    finishCrawl('No courses found. Try starting the scan from inside a course.');
    return;
  }

  crawlState.totalPages = crawlState.courses.length * 5; // estimate
  broadcastProgress(`Found ${crawlState.courses.length} courses! Diving into ${crawlState.courses[0].name}...`);

  crawlState.currentCourseIndex = 0;
  startCrawlingCurrentCourse();
}

function startCrawlingCurrentCourse() {
  const courseId = getCurrentCourseId();
  const name = getCurrentCourseName();
  crawlState.assignments = [];
  crawlState.currentAssignmentIndex = 0;

  broadcastProgress(`Opening Content for ${name}...`);
  crawlState.phase = 'go_content';
  goToUrl(`${crawlState.baseUrl}/d2l/le/content/${courseId}/Home`);
}

function onContentParsed(parsed) {
  const courseId = getCurrentCourseId();
  const materials = (parsed.materials || []).map(m => ({ ...m, courseId }));
  crawlState.results.materials.push(...materials);

  const topicCount = materials.reduce((sum, m) => sum + (m.topics?.length || 0), 0);
  broadcastProgress(`Found ${materials.length} modules, ${topicCount} topics. Now checking assignments...`);

  // Next: go to assignments page
  crawlState.phase = 'go_assignments';
  goToUrl(`${crawlState.baseUrl}/d2l/lms/dropbox/user/folders_list.d2l?ou=${courseId}&isprv=0`);
}

function onAssignmentListParsed(parsed) {
  crawlState.assignments = parsed.assignments || [];
  const courseId = getCurrentCourseId();

  for (const a of crawlState.assignments) {
    a.courseId = courseId;
    a.assignmentType = 'dropbox';
  }

  // Update total estimate
  const remaining = crawlState.courses.length - crawlState.currentCourseIndex - 1;
  crawlState.totalPages = crawlState.pagesCompleted + crawlState.assignments.length + 1 + remaining * 5;

  if (crawlState.assignments.length > 0 && crawlState.assignments[0].detailUrl) {
    broadcastProgress(`Found ${crawlState.assignments.length} assignments. Reading each one...`);
    crawlState.currentAssignmentIndex = 0;
    goToAssignmentDetail();
  } else {
    // No detail URLs or no assignments
    if (crawlState.assignments.length > 0) {
      crawlState.results.assignments.push(...crawlState.assignments);
    }
    broadcastProgress(`${crawlState.assignments.length} assignments found. Checking quizzes...`);
    goToQuizzes();
  }
}

function goToAssignmentDetail() {
  const a = crawlState.assignments[crawlState.currentAssignmentIndex];
  if (!a?.detailUrl) {
    // Skip to next or finish assignments
    crawlState.currentAssignmentIndex++;
    if (crawlState.currentAssignmentIndex < crawlState.assignments.length) {
      goToAssignmentDetail();
    } else {
      crawlState.results.assignments.push(...crawlState.assignments);
      saveProgressToBackend();
      goToQuizzes();
    }
    return;
  }

  const url = a.detailUrl.startsWith('http') ? a.detailUrl : `${crawlState.baseUrl}${a.detailUrl}`;
  broadcastProgress(`Opening assignment ${crawlState.currentAssignmentIndex + 1}/${crawlState.assignments.length}: ${a.title}...`);
  crawlState.phase = 'go_assignment_detail';
  goToUrl(url);
}

function onAssignmentDetailParsed(parsed) {
  const a = crawlState.assignments[crawlState.currentAssignmentIndex];
  if (a && parsed) {
    a.fullInstructions = parsed.fullInstructions || null;
    a.rubric = parsed.rubric || null;
    a.requirements = parsed.requirements || [];
    a.attachments = parsed.attachments || [];
  }

  crawlState.currentAssignmentIndex++;

  if (crawlState.currentAssignmentIndex < crawlState.assignments.length) {
    goToAssignmentDetail();
  } else {
    crawlState.results.assignments.push(...crawlState.assignments);
    broadcastProgress('Done with assignments. Checking quizzes...');
    goToQuizzes();
  }
}

function goToQuizzes() {
  const courseId = getCurrentCourseId();
  crawlState.phase = 'go_quizzes';
  goToUrl(`${crawlState.baseUrl}/d2l/lms/quizzing/user/quizzes_list.d2l?ou=${courseId}`);
}

function onQuizzesParsed(parsed) {
  const courseId = getCurrentCourseId();
  const quizzes = (parsed.quizzes || []).map(q => ({ ...q, courseId }));
  crawlState.results.quizzes.push(...quizzes);

  broadcastProgress(`Found ${quizzes.length} quizzes.`);

  // Move to next course
  crawlState.currentCourseIndex++;
  if (crawlState.currentCourseIndex < crawlState.courses.length) {
    broadcastProgress(`Moving to next course: ${getCurrentCourseName()}...`);
    startCrawlingCurrentCourse();
  } else {
    finishCrawl();
  }
}

function skipCurrentStep() {
  console.log('[AA] Skipping phase:', crawlState.phase);
  switch (crawlState.phase) {
    case 'find_courses':
      finishCrawl('Could not find courses');
      break;
    case 'go_content':
      crawlState.phase = 'go_assignments';
      goToUrl(`${crawlState.baseUrl}/d2l/lms/dropbox/user/folders_list.d2l?ou=${getCurrentCourseId()}&isprv=0`);
      break;
    case 'go_assignments':
      goToQuizzes();
      break;
    case 'go_assignment_detail':
      crawlState.currentAssignmentIndex++;
      if (crawlState.currentAssignmentIndex < crawlState.assignments.length) {
        goToAssignmentDetail();
      } else {
        crawlState.results.assignments.push(...crawlState.assignments);
        goToQuizzes();
      }
      break;
    case 'go_quizzes':
      crawlState.currentCourseIndex++;
      if (crawlState.currentCourseIndex < crawlState.courses.length) {
        startCrawlingCurrentCourse();
      } else {
        finishCrawl();
      }
      break;
    default:
      finishCrawl();
  }
}

// ─── Save & Finish ──────────────────────────────────────────────────────────

async function saveProgressToBackend() {
  try {
    await callBackend('/tracker/deep-import', crawlState.results);
  } catch (err) {
    console.error('[AA] Save error:', err);
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
    broadcastProgress('Saving everything...');
    await callBackend('/tracker/deep-import', crawlState.results);
    crawlState.phase = 'done';
    broadcastProgress('Deep scan complete!');

    chrome.tabs.sendMessage(crawlState.tabId, {
      type: 'CRAWL_COMPLETE',
      results: {
        courses: crawlState.results.courses.length,
        assignments: crawlState.results.assignments.length,
        quizzes: crawlState.results.quizzes.length,
        materials: crawlState.results.materials.reduce((s, m) => s + (m.topics?.length || 0), 0),
      },
    }).catch(() => {});
  } catch (err) {
    crawlState.error = 'Failed to save';
    crawlState.phase = 'error';
    broadcastProgress('Error saving results');
  }
}

// ─── Backend ────────────────────────────────────────────────────────────────

async function callBackend(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Backend failed');
  return data;
}

// ─── Progress ───────────────────────────────────────────────────────────────

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
