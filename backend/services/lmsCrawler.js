const { chromium } = require('playwright');

/**
 * Brightspace LMS Crawler
 *
 * Automates login and extraction of courses + assignments from
 * D2L Brightspace. Designed to be extended for other LMS platforms.
 */

const TIMEOUTS = {
  navigation: 30000,
  selector: 10000,
  betweenPages: 1500,
};

async function createBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });
}

async function createContext(browser) {
  return browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });
}

/**
 * Main sync function — logs in, discovers courses, extracts assignments.
 * Returns { courses, assignments } with structured data.
 */
async function syncBrightspace(lmsUrl, username, password, onProgress) {
  const progress = onProgress || (() => {});
  const browser = await createBrowser();

  try {
    const context = await createContext(browser);
    const page = await context.newPage();

    // Block unnecessary resources to speed up crawling
    await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf}', (route) =>
      route.abort()
    );

    // Step 1: Login
    progress('Logging in to Brightspace...');
    await login(page, lmsUrl, username, password);

    // Step 2: Discover courses
    progress('Discovering courses...');
    const courses = await discoverCourses(page, lmsUrl);
    progress(`Found ${courses.length} courses`);

    // Step 3: Extract assignments from each course
    const allAssignments = [];
    for (let i = 0; i < courses.length; i++) {
      const course = courses[i];
      progress(`Scanning ${course.name} (${i + 1}/${courses.length})...`);

      try {
        const assignments = await extractCourseAssignments(page, lmsUrl, course);
        allAssignments.push(...assignments);
      } catch (err) {
        console.error(`Failed to extract assignments for ${course.name}:`, err.message);
        // Continue with other courses
      }

      // Polite delay between courses
      await page.waitForTimeout(TIMEOUTS.betweenPages);
    }

    progress(`Sync complete: ${courses.length} courses, ${allAssignments.length} assignments`);

    return { courses, assignments: allAssignments };
  } finally {
    await browser.close();
  }
}

/**
 * Handles Brightspace login flow.
 * Brightspace login pages vary by institution, so we try multiple selectors.
 */
async function login(page, lmsUrl, username, password) {
  const loginUrl = `${lmsUrl}/d2l/login`;
  await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: TIMEOUTS.navigation });

  // Try common Brightspace login form selectors
  const usernameSelectors = [
    '#userName', '#username', '#email',
    'input[name="userName"]', 'input[name="username"]', 'input[name="email"]',
    'input[type="email"]', 'input[type="text"]',
  ];

  const passwordSelectors = [
    '#password', '#passwd',
    'input[name="password"]', 'input[name="passwd"]',
    'input[type="password"]',
  ];

  const submitSelectors = [
    '#submitButton', 'button[type="submit"]',
    'input[type="submit"]', '.d2l-button-primary',
    'button.primary', 'button[name="submit"]',
  ];

  // Fill username
  const usernameField = await findFirstVisible(page, usernameSelectors);
  if (!usernameField) {
    throw new Error('Could not find username field on login page');
  }
  await usernameField.fill(username);

  // Fill password
  const passwordField = await findFirstVisible(page, passwordSelectors);
  if (!passwordField) {
    throw new Error('Could not find password field on login page');
  }
  await passwordField.fill(password);

  // Submit
  const submitButton = await findFirstVisible(page, submitSelectors);
  if (!submitButton) {
    throw new Error('Could not find submit button on login page');
  }
  await submitButton.click();

  // Wait for navigation after login
  await page.waitForURL((url) => !url.href.includes('/login'), {
    timeout: TIMEOUTS.navigation,
  });

  // Verify login succeeded — check for common post-login indicators
  const currentUrl = page.url();
  if (currentUrl.includes('/login') || currentUrl.includes('error')) {
    throw new Error('Login failed — check your credentials');
  }
}

/**
 * Discovers enrolled courses from the Brightspace homepage.
 */
async function discoverCourses(page, lmsUrl) {
  // Navigate to the homepage / my courses
  await page.goto(`${lmsUrl}/d2l/home`, {
    waitUntil: 'networkidle',
    timeout: TIMEOUTS.navigation,
  });

  // Try the Brightspace enrollments widget / course cards
  // Multiple strategies since Brightspace theming varies
  const courses = [];

  // Strategy 1: Course selector widget (common in newer Brightspace)
  const courseCards = await page.$$('.course-card, .d2l-card, [class*="enrollment-card"]');
  if (courseCards.length > 0) {
    for (const card of courseCards) {
      const course = await extractCourseFromCard(card);
      if (course) courses.push(course);
    }
  }

  // Strategy 2: Course links in a list/table
  if (courses.length === 0) {
    const courseLinks = await page.$$('a[href*="/d2l/home/"]');
    for (const link of courseLinks) {
      const href = await link.getAttribute('href');
      const text = await link.innerText();

      if (href && text && href.match(/\/d2l\/home\/\d+/)) {
        const courseId = href.match(/\/d2l\/home\/(\d+)/)?.[1];
        if (courseId) {
          courses.push({
            platformCourseId: courseId,
            name: text.trim(),
            courseCode: extractCourseCode(text.trim()),
            url: `${lmsUrl}/d2l/home/${courseId}`,
          });
        }
      }
    }
  }

  // Strategy 3: Try the My Courses page directly
  if (courses.length === 0) {
    await page.goto(`${lmsUrl}/d2l/le/manageCourses/search/6605`, {
      waitUntil: 'networkidle',
      timeout: TIMEOUTS.navigation,
    });

    const rows = await page.$$('tr[class*="d2l"], .d2l-datalist-item');
    for (const row of rows) {
      const link = await row.$('a[href*="/d2l/home/"]');
      if (link) {
        const href = await link.getAttribute('href');
        const text = await link.innerText();
        const courseId = href?.match(/\/d2l\/home\/(\d+)/)?.[1];
        if (courseId && text) {
          courses.push({
            platformCourseId: courseId,
            name: text.trim(),
            courseCode: extractCourseCode(text.trim()),
            url: `${lmsUrl}/d2l/home/${courseId}`,
          });
        }
      }
    }
  }

  // Deduplicate by courseId
  const seen = new Set();
  return courses.filter((c) => {
    if (seen.has(c.platformCourseId)) return false;
    seen.add(c.platformCourseId);
    return true;
  });
}

async function extractCourseFromCard(card) {
  try {
    const link = await card.$('a[href*="/d2l/home/"]');
    if (!link) return null;

    const href = await link.getAttribute('href');
    const text = await link.innerText();
    const courseId = href?.match(/\/d2l\/home\/(\d+)/)?.[1];

    if (!courseId || !text) return null;

    return {
      platformCourseId: courseId,
      name: text.trim(),
      courseCode: extractCourseCode(text.trim()),
      url: href,
    };
  } catch {
    return null;
  }
}

/**
 * Extracts assignments from a single course.
 * Tries multiple Brightspace assignment page patterns.
 */
async function extractCourseAssignments(page, lmsUrl, course) {
  const courseId = course.platformCourseId;
  const assignments = [];

  // Try Assignments/Dropbox page
  const assignmentUrls = [
    `${lmsUrl}/d2l/lms/dropbox/user/folders_list.d2l?ou=${courseId}&isprv=0`,
    `${lmsUrl}/d2l/lms/dropbox/user/folders_list.d2l?ou=${courseId}`,
  ];

  for (const url of assignmentUrls) {
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: TIMEOUTS.navigation });

      // Look for assignment rows in the dropbox/folders list
      const rows = await page.$$('.d2l-datalist-item, tr.d_ggl1, tr.d_ggl2, tr[class*="d2l"], .d2l-table-row');

      for (const row of rows) {
        const assignment = await extractAssignmentFromRow(row, courseId);
        if (assignment) {
          assignments.push(assignment);
        }
      }

      if (assignments.length > 0) break;

      // Fallback: try finding assignment links more broadly
      const links = await page.$$('a[href*="dropbox"][href*="folder"]');
      for (const link of links) {
        const text = await link.innerText().catch(() => '');
        const href = await link.getAttribute('href');
        if (text && text.trim().length > 2) {
          assignments.push({
            platformAssignmentId: href?.match(/db=(\d+)/)?.[1] || `${courseId}_${text.trim().slice(0, 20)}`,
            courseId,
            title: text.trim(),
            assignmentUrl: href ? `${lmsUrl}${href}` : null,
            assignmentType: 'dropbox',
          });
        }
      }

      if (assignments.length > 0) break;
    } catch (err) {
      console.error(`Failed to load assignments page for course ${courseId}:`, err.message);
    }
  }

  // Also try Quizzes page
  try {
    await page.goto(`${lmsUrl}/d2l/lms/quizzing/user/quizzes_list.d2l?ou=${courseId}`, {
      waitUntil: 'networkidle',
      timeout: TIMEOUTS.navigation,
    });

    const quizLinks = await page.$$('a[href*="quiz"]');
    for (const link of quizLinks) {
      const text = await link.innerText().catch(() => '');
      const href = await link.getAttribute('href');
      if (text && text.trim().length > 2 && href?.includes('qu=')) {
        const quizId = href.match(/qu=(\d+)/)?.[1];
        assignments.push({
          platformAssignmentId: quizId || `quiz_${courseId}_${text.trim().slice(0, 20)}`,
          courseId,
          title: text.trim(),
          assignmentUrl: href ? `${lmsUrl}${href}` : null,
          assignmentType: 'quiz',
        });
      }
    }
  } catch {
    // Quizzes page may not exist for all courses
  }

  return assignments;
}

async function extractAssignmentFromRow(row, courseId) {
  try {
    // Get assignment title
    const titleEl = await row.$('a, .d2l-heading, .d2l-textblock, th');
    if (!titleEl) return null;

    const title = await titleEl.innerText().catch(() => '');
    if (!title || title.trim().length < 2) return null;

    const href = await titleEl.getAttribute('href').catch(() => null);

    // Try to extract due date
    const dueDateText = await extractTextByPattern(row, /due|deadline|closes/i);
    const dueDate = dueDateText ? parseDateString(dueDateText) : null;

    // Try to extract points
    const pointsText = await extractTextByPattern(row, /\/\s*\d+|points|score/i);
    const points = pointsText ? parseFloat(pointsText.match(/(\d+(?:\.\d+)?)/)?.[1]) : null;

    // Try to extract submission status
    const statusText = await row.innerText().catch(() => '');
    const status = inferSubmissionStatus(statusText);

    const assignmentId = href?.match(/(?:db|fid|qu)=(\d+)/)?.[1] ||
      `${courseId}_${title.trim().slice(0, 30)}`;

    return {
      platformAssignmentId: assignmentId,
      courseId,
      title: title.trim(),
      dueDate,
      pointsPossible: points,
      submissionStatus: status,
      assignmentUrl: href,
      assignmentType: 'dropbox',
    };
  } catch {
    return null;
  }
}

// --- Utility Functions ---

async function findFirstVisible(page, selectors) {
  for (const selector of selectors) {
    try {
      const el = await page.$(selector);
      if (el && (await el.isVisible())) return el;
    } catch {
      continue;
    }
  }
  return null;
}

async function extractTextByPattern(element, pattern) {
  try {
    const cells = await element.$$('td, span, div, small');
    for (const cell of cells) {
      const text = await cell.innerText();
      if (pattern.test(text)) return text;
    }
  } catch {
    // ignore
  }
  return null;
}

function extractCourseCode(courseName) {
  // Try to extract course code like "CIS 101" or "BIOL-2301"
  const match = courseName.match(/([A-Z]{2,5}[-\s]?\d{3,5})/i);
  return match ? match[1].trim() : null;
}

function parseDateString(text) {
  if (!text) return null;

  // Try to extract a date from messy text
  // Common formats: "Due: Mar 15, 2026", "Deadline: 2026-03-15", "Mar 15 at 11:59 PM"
  const cleaned = text.replace(/due|deadline|closes|opens|available/gi, '').trim();

  const date = new Date(cleaned);
  if (!isNaN(date.getTime()) && date.getFullYear() > 2020) {
    return date.toISOString();
  }
  return null;
}

function inferSubmissionStatus(text) {
  const lower = text.toLowerCase();
  if (lower.includes('submitted') || lower.includes('completed')) return 'submitted';
  if (lower.includes('graded') || lower.includes('marked')) return 'graded';
  if (lower.includes('overdue') || lower.includes('past due')) return 'overdue';
  return 'not_submitted';
}

module.exports = { syncBrightspace };
