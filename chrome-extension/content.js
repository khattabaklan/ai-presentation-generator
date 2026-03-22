// ─── Deep Crawl Content Script ───────────────────────────────────────────────
// Runs on every Brightspace page. Performs visual interactions — clicking
// elements, scrolling, highlighting — like a student navigating the LMS.
// Communicates with background.js across page navigations.

(() => {
  const isBrightspace =
    window.location.href.includes('/d2l/') || window.location.href.includes('brightspace');
  if (!isBrightspace) return;

  console.log('[AA] Content script loaded on:', window.location.href);

  // ─── Overlay UI (Shadow DOM) ───────────────────────────────────────────────

  let overlayHost = null;
  let overlayRoot = null;
  let statusText = null;
  let progressFill = null;
  let statsText = null;

  function createOverlay() {
    if (overlayHost) return;

    overlayHost = document.createElement('div');
    overlayHost.id = 'academic-assistant-overlay';
    overlayRoot = overlayHost.attachShadow({ mode: 'closed' });

    overlayRoot.innerHTML = `
      <style>
        :host {
          all: initial;
          position: fixed;
          bottom: 20px;
          right: 20px;
          z-index: 2147483647;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        }
        .panel {
          background: #0f1117;
          border: 1px solid #6366f1;
          border-radius: 12px;
          padding: 16px;
          width: 320px;
          color: #e4e4e7;
          box-shadow: 0 8px 32px rgba(99, 102, 241, 0.3);
          animation: slideIn 0.3s ease-out;
        }
        @keyframes slideIn {
          from { transform: translateY(20px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        .header {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 12px;
        }
        .logo {
          width: 8px;
          height: 8px;
          background: #6366f1;
          border-radius: 50%;
          animation: pulse 1.5s infinite;
        }
        @keyframes pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.4); }
          50% { box-shadow: 0 0 0 6px rgba(99, 102, 241, 0); }
        }
        .title {
          font-size: 13px;
          font-weight: 600;
          color: #fff;
        }
        .status {
          font-size: 12px;
          color: #a5b4fc;
          margin-bottom: 8px;
          min-height: 16px;
        }
        .progress-bar {
          width: 100%;
          height: 4px;
          background: #27272a;
          border-radius: 2px;
          overflow: hidden;
          margin-bottom: 8px;
        }
        .progress-fill {
          height: 100%;
          background: linear-gradient(90deg, #6366f1, #8b5cf6);
          border-radius: 2px;
          transition: width 0.4s ease;
          width: 0%;
        }
        .stats {
          font-size: 11px;
          color: #71717a;
        }
        .done .logo { background: #22c55e; animation: none; }
        .done .progress-fill { background: #22c55e; width: 100% !important; }
        .done .status { color: #22c55e; }
      </style>
      <div class="panel" id="panel">
        <div class="header">
          <div class="logo"></div>
          <div class="title">Academic Assistant</div>
        </div>
        <div class="status" id="status">Preparing to scan...</div>
        <div class="progress-bar">
          <div class="progress-fill" id="progress"></div>
        </div>
        <div class="stats" id="stats"></div>
      </div>
    `;

    document.body.appendChild(overlayHost);
    statusText = overlayRoot.getElementById('status');
    progressFill = overlayRoot.getElementById('progress');
    statsText = overlayRoot.getElementById('stats');
  }

  function updateOverlay(message, pagesCompleted, totalPages, coursesFound, assignmentsFound) {
    if (!overlayHost) createOverlay();
    if (statusText) statusText.textContent = message || 'Working...';
    if (progressFill && totalPages > 0) {
      const pct = Math.min(100, Math.round((pagesCompleted / totalPages) * 100));
      progressFill.style.width = pct + '%';
    }
    if (statsText) {
      const parts = [];
      if (coursesFound > 0) parts.push(`${coursesFound} courses`);
      if (assignmentsFound > 0) parts.push(`${assignmentsFound} assignments`);
      if (pagesCompleted > 0) parts.push(`${pagesCompleted}/${totalPages} pages`);
      statsText.textContent = parts.join(' · ');
    }
  }

  function showComplete(results) {
    if (!overlayHost) createOverlay();
    const panel = overlayRoot.getElementById('panel');
    if (panel) panel.classList.add('done');
    if (statusText) statusText.textContent = 'Deep scan complete!';
    if (statsText) {
      statsText.textContent = `${results.courses} courses · ${results.assignments} assignments · ${results.quizzes} quizzes · ${results.materials} materials`;
    }
    setTimeout(() => {
      if (overlayHost && overlayHost.parentNode) {
        overlayHost.style.transition = 'opacity 0.5s';
        overlayHost.style.opacity = '0';
        setTimeout(() => overlayHost.remove(), 500);
      }
    }, 5000);
  }

  // ─── Highlight & Click Styles ──────────────────────────────────────────────

  const highlightStyle = document.createElement('style');
  highlightStyle.textContent = `
    .aa-highlight {
      outline: 2px solid #6366f1 !important;
      outline-offset: 2px !important;
      box-shadow: 0 0 12px rgba(99, 102, 241, 0.4) !important;
      transition: outline 0.3s, box-shadow 0.3s !important;
    }
    .aa-clicking {
      outline: 3px solid #22c55e !important;
      outline-offset: 2px !important;
      box-shadow: 0 0 20px rgba(34, 197, 94, 0.5) !important;
      transition: all 0.2s !important;
    }
  `;
  document.head.appendChild(highlightStyle);

  function highlightAll(selector) {
    const elements = document.querySelectorAll(selector);
    elements.forEach((el) => el.classList.add('aa-highlight'));
    return elements.length;
  }

  function clearHighlights() {
    document.querySelectorAll('.aa-highlight, .aa-clicking').forEach((el) => {
      el.classList.remove('aa-highlight', 'aa-clicking');
    });
  }

  // ─── Visual Click ─────────────────────────────────────────────────────────
  // Scrolls to an element, highlights it green, pauses, then clicks it.

  function visualClick(element) {
    return new Promise((resolve) => {
      // Scroll the element into view
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });

      setTimeout(() => {
        // Highlight it green (about to click)
        element.classList.add('aa-clicking');

        setTimeout(() => {
          // Click it — this may navigate away, destroying this script
          console.log('[AA] Clicking:', element.textContent.trim().substring(0, 60));
          element.click();
          resolve();
        }, 600);
      }, 400);
    });
  }

  // ─── Smooth Scroll ────────────────────────────────────────────────────────

  function smoothScrollToBottom() {
    return new Promise((resolve) => {
      const scrollHeight = document.documentElement.scrollHeight;
      const viewportHeight = window.innerHeight;
      const step = Math.floor(viewportHeight * 0.7);
      let currentPos = 0;

      function scrollStep() {
        currentPos += step;
        if (currentPos >= scrollHeight) {
          window.scrollTo({ top: scrollHeight, behavior: 'smooth' });
          setTimeout(resolve, 400);
          return;
        }
        window.scrollTo({ top: currentPos, behavior: 'smooth' });
        setTimeout(scrollStep, 500);
      }

      scrollStep();
    });
  }

  // ─── Text Extraction ──────────────────────────────────────────────────────

  function extractPageText() {
    const clone = document.body.cloneNode(true);
    const remove = clone.querySelectorAll(
      'script, style, svg, iframe, img, noscript, link, meta, #academic-assistant-overlay'
    );
    remove.forEach((el) => el.remove());

    let text = clone.innerText || clone.textContent || '';
    text = text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();

    // Grab all d2l links with their labels
    const links = document.querySelectorAll('a[href*="/d2l/"]');
    const linkData = [];
    links.forEach((a) => {
      const href = a.getAttribute('href');
      const label = a.textContent.trim();
      if (href && label && label.length > 1) {
        linkData.push(`[LINK: "${label}" → ${href}]`);
      }
    });

    if (linkData.length > 0) {
      text += '\n\n─── PAGE LINKS ───\n' + linkData.join('\n');
    }

    return text;
  }

  // ─── DOM Extractors ───────────────────────────────────────────────────────

  // Recursively search through Shadow DOM to find all elements matching a selector
  function deepQueryAll(root, selector) {
    const results = [...root.querySelectorAll(selector)];

    // Search inside shadow roots
    root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) {
        results.push(...deepQueryAll(el.shadowRoot, selector));
      }
    });

    // Also check iframes on same origin
    root.querySelectorAll('iframe').forEach((iframe) => {
      try {
        if (iframe.contentDocument) {
          results.push(...deepQueryAll(iframe.contentDocument, selector));
        }
      } catch (e) {
        // Cross-origin iframe, skip
      }
    });

    return results;
  }

  function extractCoursesFromDOM() {
    const courses = [];
    const seen = new Set();

    // Search everywhere including Shadow DOM and iframes
    const allLinks = deepQueryAll(document, 'a[href*="/d2l/home/"]');
    console.log('[AA] Found links with /d2l/home/:', allLinks.length);

    allLinks.forEach((link) => {
      const href = link.getAttribute('href') || '';
      const match = href.match(/\/d2l\/home\/(\d+)/);
      if (!match) return;

      const courseId = match[1];
      if (seen.has(courseId)) return;
      seen.add(courseId);

      let name = link.textContent.trim();
      if (!name || name.length < 3) {
        // Walk up to find a parent with text
        let parent = link.parentElement;
        for (let i = 0; i < 5 && parent; i++) {
          const text = parent.textContent.trim();
          if (text && text.length > 3 && text.length < 300) {
            name = text.split('\n').filter(l => l.trim().length > 2)[0]?.trim() || text.substring(0, 200);
            break;
          }
          parent = parent.parentElement;
        }
      }
      if (!name || name.length < 3) return;

      // Clean up name — take first meaningful line
      name = name.split('\n')[0].trim();
      if (name.length > 200) name = name.substring(0, 200);

      const codeMatch = name.match(/\(([A-Z]{2,5}[-\s]?\d{3,5}[A-Za-z0-9-]*)\)/);

      courses.push({
        courseId,
        name,
        code: codeMatch ? codeMatch[1].trim() : null,
        url: `${window.location.origin}/d2l/home/${courseId}`,
      });
    });

    // Fallback: search the entire page HTML for /d2l/home/{id} patterns
    if (courses.length === 0) {
      console.log('[AA] No courses from DOM, trying HTML regex fallback');
      const html = document.documentElement.innerHTML;
      const regex = /\/d2l\/home\/(\d{4,})/g;
      let m;
      while ((m = regex.exec(html)) !== null) {
        const courseId = m[1];
        if (seen.has(courseId)) continue;
        seen.add(courseId);
        courses.push({
          courseId,
          name: `Course ${courseId}`,
          code: null,
          url: `${window.location.origin}/d2l/home/${courseId}`,
        });
      }
    }

    console.log('[AA] Extracted courses:', courses.length, courses.map(c => c.name));
    return courses;
  }

  // ─── Action Handlers ──────────────────────────────────────────────────────
  // Each action corresponds to a phase from background.js

  const actions = {
    // Phase: courses — find all courses, highlight cards, send data
    async extract_courses(progress) {
      updateOverlay('Waiting for courses to load...', progress.pagesCompleted, progress.totalPages, 0, 0);

      // Wait for Brightspace widgets to load — they're slow and dynamic
      await new Promise((r) => setTimeout(r, 3000));

      // Scroll to trigger lazy loading
      await smoothScrollToBottom();
      await new Promise((r) => setTimeout(r, 1500));

      // Try to find courses — retry a few times as widgets load
      let courses = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        courses = extractCoursesFromDOM();
        if (courses.length > 0) break;
        console.log(`[AA] Attempt ${attempt + 1}: no courses yet, waiting...`);
        updateOverlay('Looking for course widgets...', progress.pagesCompleted, progress.totalPages, 0, 0);
        await new Promise((r) => setTimeout(r, 2000));
        // Scroll again to trigger any remaining lazy loads
        window.scrollTo({ top: 0, behavior: 'smooth' });
        await new Promise((r) => setTimeout(r, 500));
        await smoothScrollToBottom();
        await new Promise((r) => setTimeout(r, 1000));
      }

      // Highlight found course links
      const highlighted = highlightAll('a[href*="/d2l/home/"]');
      console.log('[AA] Highlighted course links:', highlighted);
      await new Promise((r) => setTimeout(r, 800));

      clearHighlights();
      window.scrollTo({ top: 0, behavior: 'smooth' });

      chrome.runtime.sendMessage({
        type: 'PAGE_DATA',
        payload: { pageType: 'courses', directData: { courses } },
      });
    },

    // Phase: click_course — click into a specific course card
    async click_course(progress, data) {
      const { courseId } = data;
      updateOverlay(`Opening course...`, progress.pagesCompleted, progress.totalPages, progress.coursesFound, 0);

      await new Promise((r) => setTimeout(r, 1000));

      // Find the course link
      const courseLink = document.querySelector(`a[href*="/d2l/home/${courseId}"]`);
      if (courseLink) {
        await visualClick(courseLink);
        // Navigation happens — script will be destroyed
      } else {
        // Fallback: navigate by URL
        chrome.runtime.sendMessage({ type: 'NAVIGATE_FALLBACK', url: `${window.location.origin}/d2l/home/${courseId}` });
      }
    },

    // Phase: click_nav — click a navigation link within a course (Content, Assignments, Quizzes)
    async click_nav(progress, data) {
      const { target } = data; // 'content', 'assignments', or 'quizzes'
      const targetLabels = {
        content: ['Content', 'Course Content', 'Materials'],
        assignments: ['Assignments', 'Dropbox', 'Activities'],
        quizzes: ['Quizzes', 'Quiz', 'Assessments'],
      };

      const labels = targetLabels[target] || [target];
      updateOverlay(`Looking for ${labels[0]}...`, progress.pagesCompleted, progress.totalPages, progress.coursesFound, progress.assignmentsFound);

      await new Promise((r) => setTimeout(r, 1500));

      // Look for nav links matching our target
      let navLink = null;

      // Try the course navbar first
      const allLinks = document.querySelectorAll('a[href*="/d2l/"]');
      for (const link of allLinks) {
        const text = link.textContent.trim();
        for (const label of labels) {
          if (text.toLowerCase().includes(label.toLowerCase())) {
            navLink = link;
            break;
          }
        }
        if (navLink) break;
      }

      if (navLink) {
        // Highlight the navbar area first
        const navbar = navLink.closest('nav, [class*="nav"], [class*="toolbar"], [role="navigation"]');
        if (navbar) {
          navbar.classList.add('aa-highlight');
          await new Promise((r) => setTimeout(r, 400));
        }

        await visualClick(navLink);
        // Navigation happens
      } else {
        console.log('[AA] Nav link not found for:', target, '— using URL fallback');
        chrome.runtime.sendMessage({ type: 'NAV_NOT_FOUND', target });
      }
    },

    // Phase: read_page — scroll through and extract text, send to Claude
    async read_page(progress, data) {
      const { pageType } = data;
      updateOverlay(`Reading ${pageType.replace('_', ' ')}...`, progress.pagesCompleted, progress.totalPages, progress.coursesFound, progress.assignmentsFound);

      await new Promise((r) => setTimeout(r, 1500));

      // Highlight relevant elements
      switch (pageType) {
        case 'assignments_list':
          highlightAll('.d2l-datalist-item, tr[class*="d2l"], a[href*="dropbox"], a[href*="folder"]');
          break;
        case 'assignment_detail':
          highlightAll('.d2l-htmlblock, .d2l-richtext, [class*="instructions"], [class*="rubric"]');
          break;
        case 'quizzes':
          highlightAll('a[href*="quiz"], .d2l-datalist-item, tr[class*="d2l"]');
          break;
        case 'course_content':
          highlightAll('.d2l-le-TreeAccordion, [class*="module"], [class*="content-toc"]');
          break;
      }

      await smoothScrollToBottom();
      await new Promise((r) => setTimeout(r, 800));

      const text = extractPageText();
      clearHighlights();
      window.scrollTo({ top: 0, behavior: 'smooth' });

      chrome.runtime.sendMessage({
        type: 'PAGE_DATA',
        payload: { text, pageType },
      });
    },

    // Phase: click_assignment — click into a specific assignment for details
    async click_assignment(progress, data) {
      const { assignmentIndex, assignmentTitle } = data;
      updateOverlay(`Opening: ${assignmentTitle || 'assignment'}...`, progress.pagesCompleted, progress.totalPages, progress.coursesFound, progress.assignmentsFound);

      await new Promise((r) => setTimeout(r, 1000));

      // Find assignment links — look for dropbox/folder links
      const assignmentLinks = [];
      document.querySelectorAll('a[href*="dropbox"], a[href*="folder"], a[href*="fid="], a[href*="db="]').forEach((link) => {
        const text = link.textContent.trim();
        if (text && text.length > 2) {
          assignmentLinks.push(link);
        }
      });

      // Also try more generic assignment links
      if (assignmentLinks.length === 0) {
        document.querySelectorAll('.d2l-datalist-item a, td a[href*="/d2l/"]').forEach((link) => {
          const text = link.textContent.trim();
          if (text && text.length > 2) {
            assignmentLinks.push(link);
          }
        });
      }

      if (assignmentIndex < assignmentLinks.length) {
        await visualClick(assignmentLinks[assignmentIndex]);
      } else if (data.detailUrl) {
        // Fallback: navigate by URL
        const url = data.detailUrl.startsWith('http') ? data.detailUrl : `${window.location.origin}${data.detailUrl}`;
        chrome.runtime.sendMessage({ type: 'NAVIGATE_FALLBACK', url });
      } else {
        chrome.runtime.sendMessage({ type: 'CLICK_FAILED', reason: 'Assignment link not found' });
      }
    },
  };

  // ─── Message Listener ─────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'CRAWL_ACTION') {
      const { action, progress, data } = msg;
      console.log('[AA] Received action:', action, data);

      createOverlay();
      if (actions[action]) {
        actions[action](progress || {}, data || {});
      } else {
        console.error('[AA] Unknown action:', action);
      }
      sendResponse({ received: true });
      return;
    }

    if (msg.type === 'CRAWL_PROGRESS') {
      updateOverlay(msg.message, msg.pagesCompleted, msg.totalPages, msg.coursesFound, msg.assignmentsFound);
      return;
    }

    if (msg.type === 'CRAWL_COMPLETE') {
      showComplete(msg.results);
      return;
    }
  });

  // ─── Announce to Background ────────────────────────────────────────────────

  setTimeout(() => {
    chrome.runtime.sendMessage({ type: 'PAGE_READY' });
  }, 800);
})();
