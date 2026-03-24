const { chromium } = require('playwright');
const { parsePageContent } = require('./claude');

/**
 * Deep Brightspace LMS Crawler
 *
 * State-machine scraper that mirrors the Chrome extension's deep crawl:
 * Login → Find Courses → For each course:
 *   1. Content page (modules/topics)
 *   2. Assignments list
 *   3. Each assignment detail (full instructions, rubric)
 *   4. Quizzes page
 *
 * Uses Claude via parsePageContent() to extract structured data from raw page
 * text — no brittle CSS selectors for data extraction.
 */

const TIMEOUTS = {
  navigation: 30000,
  networkIdle: 15000,
  betweenPages: 1500,
  scrollStep: 400,
};

const MAX_TEXT_LENGTH = 100000;

// ─── Browser Setup ──────────────────────────────────────────────────────────

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

// ─── Navigation Helpers ─────────────────────────────────────────────────────

/**
 * Navigate to URL with networkidle, falling back to domcontentloaded + wait
 * if networkidle times out (Brightspace has persistent connections).
 */
async function navigateAndWait(page, url, lmsUrl, credentials) {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: TIMEOUTS.networkIdle });
  } catch {
    // networkidle timeout — fall back to domcontentloaded + delay
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
    } catch {
      // Already on the page from the first attempt, just wait
    }
    await page.waitForTimeout(3000);
  }

  // Check if session expired and we got redirected to login
  if (credentials && lmsUrl) {
    const alive = await checkSessionAlive(page, lmsUrl);
    if (!alive) {
      console.log('[Crawler] Session expired, re-logging in...');
      await login(page, lmsUrl, credentials.username, credentials.password);
      // Retry the original navigation
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: TIMEOUTS.networkIdle });
      } catch {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
        await page.waitForTimeout(3000);
      }
    }
  }
}

/**
 * Check if we're still logged in (not redirected to login page).
 */
async function checkSessionAlive(page, lmsUrl) {
  const currentUrl = page.url();
  if (currentUrl.includes('/d2l/login') || currentUrl.includes('/login')) {
    return false;
  }
  return true;
}

/**
 * Scroll to bottom incrementally to trigger lazy-loaded content.
 */
async function scrollToBottom(page) {
  await page.evaluate(async (stepDelay) => {
    const max = document.documentElement.scrollHeight;
    const step = Math.floor(window.innerHeight * 0.7);
    let pos = 0;
    while (pos < max) {
      pos += step;
      window.scrollTo({ top: pos, behavior: 'smooth' });
      await new Promise(r => setTimeout(r, stepDelay));
    }
    window.scrollTo({ top: 0 });
  }, TIMEOUTS.scrollStep);
}

/**
 * Extract page text + all /d2l/ links with labels.
 * Ported from chrome-extension/content.js extractText().
 */
async function extractPageText(page) {
  return page.evaluate(() => {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('script,style,svg,iframe,img,noscript,link,meta').forEach(e => e.remove());
    let text = (clone.innerText || clone.textContent || '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();

    // Append all d2l links with labels — Claude needs URLs to find detail links
    const links = [];
    document.querySelectorAll('a[href*="/d2l/"]').forEach(a => {
      const href = a.getAttribute('href');
      const label = a.textContent.trim();
      if (href && label && label.length > 1) {
        links.push(`[LINK: "${label}" → ${href}]`);
      }
    });
    if (links.length > 0) {
      text += '\n\n─── PAGE LINKS ───\n' + links.join('\n');
    }
    return text;
  });
}

// ─── Login ──────────────────────────────────────────────────────────────────

async function login(page, lmsUrl, username, password) {
  const loginUrl = `${lmsUrl}/d2l/login`;
  await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: TIMEOUTS.navigation });

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

  const usernameField = await findFirstVisible(page, usernameSelectors);
  if (!usernameField) throw new Error('Could not find username field on login page');
  await usernameField.fill(username);

  const passwordField = await findFirstVisible(page, passwordSelectors);
  if (!passwordField) throw new Error('Could not find password field on login page');
  await passwordField.fill(password);

  const submitButton = await findFirstVisible(page, submitSelectors);
  if (!submitButton) throw new Error('Could not find submit button on login page');
  await submitButton.click();

  await page.waitForURL((url) => !url.href.includes('/login'), {
    timeout: TIMEOUTS.navigation,
  });

  const currentUrl = page.url();
  if (currentUrl.includes('/login') || currentUrl.includes('error')) {
    throw new Error('Login failed — check your credentials');
  }
}

// ─── Course Discovery ───────────────────────────────────────────────────────

async function discoverCourses(page, lmsUrl, credentials, progress) {
  progress('Discovering courses...');
  await navigateAndWait(page, `${lmsUrl}/d2l/home`, lmsUrl, credentials);

  // Scroll to trigger lazy loading
  await scrollToBottom(page);
  await page.waitForTimeout(1000);

  // Extract page text and let Claude parse it
  const pageText = await extractPageText(page);
  const truncated = pageText.substring(0, MAX_TEXT_LENGTH);

  let courses = [];

  try {
    const parsed = await parsePageContent(truncated, 'courses');
    courses = parsed.courses || [];
  } catch (err) {
    console.error('[Crawler] Claude parse failed for courses, falling back to DOM:', err.message);
  }

  // Fallback: DOM-based extraction if Claude found nothing
  if (courses.length === 0) {
    courses = await page.evaluate((baseUrl) => {
      const results = [];
      const seen = new Set();
      document.querySelectorAll('a[href*="/d2l/home/"]').forEach(link => {
        const href = link.getAttribute('href') || '';
        const match = href.match(/\/d2l\/home\/(\d+)/);
        if (!match || seen.has(match[1])) return;
        seen.add(match[1]);
        const name = link.textContent.trim();
        if (name && name.length > 2) {
          const code = name.match(/([A-Z]{2,5}[-\s]?\d{3,5})/i);
          results.push({
            courseId: match[1],
            name: name.substring(0, 200),
            code: code ? code[1].trim() : null,
            url: `${baseUrl}/d2l/home/${match[1]}`,
          });
        }
      });
      return results;
    }, lmsUrl);
  }

  // Strategy 3: Try My Courses page
  if (courses.length === 0) {
    await navigateAndWait(page, `${lmsUrl}/d2l/le/manageCourses/search/6605`, lmsUrl, null);
    const text2 = await extractPageText(page);
    try {
      const parsed2 = await parsePageContent(text2.substring(0, MAX_TEXT_LENGTH), 'courses');
      courses = parsed2.courses || [];
    } catch {
      // Last resort DOM fallback already tried above
    }
  }

  // Ensure URLs are absolute
  courses = courses.map(c => ({
    ...c,
    url: c.url || `${lmsUrl}/d2l/home/${c.courseId}`,
  }));

  // Deduplicate
  const seen = new Set();
  courses = courses.filter(c => {
    if (seen.has(c.courseId)) return false;
    seen.add(c.courseId);
    return true;
  });

  progress(`Found ${courses.length} courses`);
  return courses;
}

// ─── Content Modules Crawl ──────────────────────────────────────────────────

async function crawlContentModules(page, lmsUrl, courseId, credentials, progress) {
  const contentUrl = `${lmsUrl}/d2l/le/content/${courseId}/Home`;
  await navigateAndWait(page, contentUrl, lmsUrl, credentials);
  await scrollToBottom(page);

  // Extract top-level content page
  const pageText = await extractPageText(page);
  let materials = [];

  try {
    const parsed = await parsePageContent(pageText.substring(0, MAX_TEXT_LENGTH), 'course_content', courseId);
    materials = parsed.materials || [];
  } catch (err) {
    console.error(`[Crawler] Failed to parse content page for course ${courseId}:`, err.message);
    return [];
  }

  // Click into each module in the sidebar to load its topics
  const moduleLinks = await page.$$('a[href*="/d2l/le/content/"]');
  const visitedUrls = new Set([page.url()]);

  for (const link of moduleLinks) {
    try {
      const href = await link.getAttribute('href');
      if (!href || visitedUrls.has(href)) continue;

      const fullUrl = href.startsWith('http') ? href : `${lmsUrl}${href}`;
      // Only follow links that look like module/topic pages for this course
      if (!fullUrl.includes(`/content/${courseId}/`)) continue;
      visitedUrls.add(fullUrl);

      await navigateAndWait(page, fullUrl, lmsUrl, credentials);
      await scrollToBottom(page);

      const topicText = await extractPageText(page);
      if (topicText.length < 50) continue; // Skip near-empty pages

      try {
        const topicParsed = await parsePageContent(
          topicText.substring(0, MAX_TEXT_LENGTH),
          'course_content',
          courseId
        );
        if (topicParsed.materials && topicParsed.materials.length > 0) {
          // Merge new materials, avoiding duplicates by module name
          const existingNames = new Set(materials.map(m => m.moduleName));
          for (const m of topicParsed.materials) {
            if (!existingNames.has(m.moduleName)) {
              materials.push(m);
              existingNames.add(m.moduleName);
            }
          }
        }
      } catch {
        // Skip individual topic parse failures
      }
    } catch {
      // Skip individual module navigation failures
    }
  }

  return materials.map(m => ({ ...m, courseId }));
}

// ─── Assignments Crawl ──────────────────────────────────────────────────────

async function crawlAssignments(page, lmsUrl, courseId, credentials, progress) {
  const listUrl = `${lmsUrl}/d2l/lms/dropbox/user/folders_list.d2l?ou=${courseId}&isprv=0`;
  await navigateAndWait(page, listUrl, lmsUrl, credentials);
  await scrollToBottom(page);

  const pageText = await extractPageText(page);
  let assignments = [];

  try {
    const parsed = await parsePageContent(pageText.substring(0, MAX_TEXT_LENGTH), 'assignments_list', courseId);
    assignments = parsed.assignments || [];
  } catch (err) {
    console.error(`[Crawler] Failed to parse assignments list for course ${courseId}:`, err.message);
    return [];
  }

  // Tag each assignment with courseId and type
  assignments = assignments.map(a => ({
    ...a,
    courseId,
    assignmentType: 'dropbox',
  }));

  return assignments;
}

async function crawlAssignmentDetail(page, lmsUrl, assignment, credentials, progress) {
  if (!assignment.detailUrl) return assignment;

  const url = assignment.detailUrl.startsWith('http')
    ? assignment.detailUrl
    : `${lmsUrl}${assignment.detailUrl}`;

  await navigateAndWait(page, url, lmsUrl, credentials);
  await scrollToBottom(page);

  const pageText = await extractPageText(page);

  try {
    const parsed = await parsePageContent(pageText.substring(0, MAX_TEXT_LENGTH), 'assignment_detail');
    assignment.fullInstructions = parsed.fullInstructions || null;
    assignment.rubric = parsed.rubric || null;
    assignment.requirements = parsed.requirements || [];
    assignment.attachments = parsed.attachments || [];
    assignment.assignmentUrl = url;
  } catch (err) {
    console.error(`[Crawler] Failed to parse detail for "${assignment.title}":`, err.message);
  }

  return assignment;
}

// ─── Quizzes Crawl ──────────────────────────────────────────────────────────

async function crawlQuizzes(page, lmsUrl, courseId, credentials, progress) {
  const quizUrl = `${lmsUrl}/d2l/lms/quizzing/user/quizzes_list.d2l?ou=${courseId}`;
  await navigateAndWait(page, quizUrl, lmsUrl, credentials);
  await scrollToBottom(page);

  const pageText = await extractPageText(page);
  let quizzes = [];

  try {
    const parsed = await parsePageContent(pageText.substring(0, MAX_TEXT_LENGTH), 'quizzes', courseId);
    quizzes = (parsed.quizzes || []).map(q => ({ ...q, courseId }));
  } catch (err) {
    console.error(`[Crawler] Failed to parse quizzes for course ${courseId}:`, err.message);
  }

  return quizzes;
}

// ─── Main Deep Sync ─────────────────────────────────────────────────────────

/**
 * Deep sync: logs in, discovers courses, then for each course crawls
 * content modules, assignments (with detail pages), and quizzes.
 *
 * Returns { courses, assignments, quizzes, materials }
 */
async function syncBrightspace(lmsUrl, username, password, onProgress) {
  const progress = onProgress || (() => {});
  const browser = await createBrowser();
  const credentials = { username, password };

  const results = {
    courses: [],
    assignments: [],
    quizzes: [],
    materials: [],
  };

  let totalPagesScraped = 0;

  try {
    const context = await createContext(browser);
    const page = await context.newPage();

    // Block images/fonts to speed up crawling
    await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf}', (route) =>
      route.abort()
    );

    // Step 1: Login
    progress('Logging in to Brightspace...');
    await login(page, lmsUrl, username, password);
    progress('Logged in successfully');

    // Step 2: Discover courses
    const courses = await discoverCourses(page, lmsUrl, credentials, progress);
    results.courses = courses;

    if (courses.length === 0) {
      progress('No courses found');
      return results;
    }

    // Step 3: Deep crawl each course
    for (let i = 0; i < courses.length; i++) {
      const course = courses[i];
      const courseId = course.courseId;
      const courseName = course.name;
      const courseProgress = `[${i + 1}/${courses.length}] ${courseName}`;

      // ── Content modules ──
      try {
        progress(`${courseProgress} — reading content modules...`);
        const materials = await crawlContentModules(page, lmsUrl, courseId, credentials, progress);
        results.materials.push(...materials);
        totalPagesScraped++;
        const topicCount = materials.reduce((sum, m) => sum + (m.topics?.length || 0), 0);
        progress(`${courseProgress} — found ${materials.length} modules, ${topicCount} topics`);
      } catch (err) {
        console.error(`[Crawler] Content crawl failed for ${courseName}:`, err.message);
      }

      await page.waitForTimeout(TIMEOUTS.betweenPages);

      // ── Assignments list ──
      let assignments = [];
      try {
        progress(`${courseProgress} — reading assignments...`);
        assignments = await crawlAssignments(page, lmsUrl, courseId, credentials, progress);
        totalPagesScraped++;
        progress(`${courseProgress} — found ${assignments.length} assignments`);
      } catch (err) {
        console.error(`[Crawler] Assignments crawl failed for ${courseName}:`, err.message);
      }

      await page.waitForTimeout(TIMEOUTS.betweenPages);

      // ── Assignment details ──
      const assignmentsWithDetails = assignments.filter(a => a.detailUrl);
      for (let j = 0; j < assignmentsWithDetails.length; j++) {
        const a = assignmentsWithDetails[j];
        try {
          progress(`${courseProgress} — reading assignment ${j + 1}/${assignmentsWithDetails.length}: ${a.title}`);
          await crawlAssignmentDetail(page, lmsUrl, a, credentials, progress);
          totalPagesScraped++;
        } catch (err) {
          console.error(`[Crawler] Detail crawl failed for "${a.title}":`, err.message);
        }
        await page.waitForTimeout(TIMEOUTS.betweenPages);
      }

      results.assignments.push(...assignments);

      // ── Quizzes ──
      try {
        progress(`${courseProgress} — reading quizzes...`);
        const quizzes = await crawlQuizzes(page, lmsUrl, courseId, credentials, progress);
        results.quizzes.push(...quizzes);
        totalPagesScraped++;
        progress(`${courseProgress} — found ${quizzes.length} quizzes`);
      } catch (err) {
        console.error(`[Crawler] Quizzes crawl failed for ${courseName}:`, err.message);
      }

      await page.waitForTimeout(TIMEOUTS.betweenPages);
    }

    progress(`Sync complete: ${courses.length} courses, ${results.assignments.length} assignments, ${results.quizzes.length} quizzes, ${results.materials.length} modules (${totalPagesScraped} pages scraped)`);

    return results;
  } finally {
    await browser.close();
  }
}

// ─── Utility Functions ──────────────────────────────────────────────────────

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

module.exports = { syncBrightspace };
