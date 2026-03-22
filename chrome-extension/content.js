// ─── Deep Crawl Content Script ───────────────────────────────────────────────
// Runs on every page. Announces itself to background.js, then waits for
// instructions. Performs visual scrolling, element highlighting, and text
// extraction when told to crawl.

(() => {
  // Only activate on Brightspace pages
  const isBrightspace =
    window.location.href.includes('/d2l/') || window.location.href.includes('brightspace');
  if (!isBrightspace) return;

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
          width: 300px;
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
        .done .logo {
          background: #22c55e;
          animation: none;
        }
        .done .progress-fill {
          background: #22c55e;
          width: 100% !important;
        }
        .done .status {
          color: #22c55e;
        }
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
    // Auto-hide after 5 seconds
    setTimeout(() => {
      if (overlayHost && overlayHost.parentNode) {
        overlayHost.style.transition = 'opacity 0.5s';
        overlayHost.style.opacity = '0';
        setTimeout(() => overlayHost.remove(), 500);
      }
    }, 5000);
  }

  function removeOverlay() {
    if (overlayHost && overlayHost.parentNode) {
      overlayHost.remove();
      overlayHost = null;
    }
  }

  // ─── Visual Scrolling ──────────────────────────────────────────────────────

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
          setTimeout(resolve, 300);
          return;
        }
        window.scrollTo({ top: currentPos, behavior: 'smooth' });
        setTimeout(scrollStep, 400);
      }

      scrollStep();
    });
  }

  // ─── Element Highlighting ──────────────────────────────────────────────────

  const highlightStyle = document.createElement('style');
  highlightStyle.textContent = `
    .aa-highlight {
      outline: 2px solid #6366f1 !important;
      outline-offset: 2px !important;
      box-shadow: 0 0 12px rgba(99, 102, 241, 0.4) !important;
      transition: outline 0.3s, box-shadow 0.3s !important;
    }
  `;
  document.head.appendChild(highlightStyle);

  function highlightElements(selector) {
    const elements = document.querySelectorAll(selector);
    elements.forEach((el) => el.classList.add('aa-highlight'));
    return elements.length;
  }

  function clearHighlights() {
    document.querySelectorAll('.aa-highlight').forEach((el) => {
      el.classList.remove('aa-highlight');
    });
  }

  // ─── Text Extraction ──────────────────────────────────────────────────────

  function extractPageText() {
    // Clone the body and strip non-content elements
    const clone = document.body.cloneNode(true);

    // Remove scripts, styles, SVGs, iframes, images
    const remove = clone.querySelectorAll(
      'script, style, svg, iframe, img, noscript, link, meta, #academic-assistant-overlay'
    );
    remove.forEach((el) => el.remove());

    // Get the text content, clean up whitespace
    let text = clone.innerText || clone.textContent || '';

    // Collapse multiple newlines and spaces
    text = text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();

    // Also grab important href attributes for navigation URLs
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

  // ─── Crawl Execution ──────────────────────────────────────────────────────

  async function executeCrawl(pageType, progress) {
    createOverlay();
    updateOverlay(
      progress.message || `Scanning ${pageType}...`,
      progress.pagesCompleted,
      progress.totalPages,
      progress.coursesFound,
      progress.assignmentsFound
    );

    // Highlight relevant elements based on page type
    switch (pageType) {
      case 'courses':
        highlightElements('a[href*="/d2l/home/"], .course-card, [class*="enrollment"]');
        break;
      case 'assignments_list':
        highlightElements('.d2l-datalist-item, tr[class*="d2l"], a[href*="dropbox"]');
        break;
      case 'assignment_detail':
        highlightElements('.d2l-htmlblock, .d2l-richtext, [class*="instructions"], [class*="rubric"]');
        break;
      case 'quizzes':
        highlightElements('a[href*="quiz"], .d2l-datalist-item');
        break;
      case 'course_content':
        highlightElements('.d2l-le-TreeAccordion, [class*="module"], [class*="content"]');
        break;
    }

    // Scroll through the page visually
    await smoothScrollToBottom();

    // Brief pause to let everything render
    await new Promise((r) => setTimeout(r, 300));

    // Extract text
    const text = extractPageText();

    // Clear highlights
    clearHighlights();

    // Scroll back to top
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // Send extracted text back to background.js
    chrome.runtime.sendMessage({
      type: 'PAGE_DATA',
      payload: { text, pageType },
    });
  }

  // ─── Message Listener ─────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'CRAWL_PAGE') {
      executeCrawl(msg.pageType, msg.progress || {});
      sendResponse({ received: true });
      return;
    }

    if (msg.type === 'CRAWL_PROGRESS') {
      updateOverlay(
        msg.message,
        msg.pagesCompleted,
        msg.totalPages,
        msg.coursesFound,
        msg.assignmentsFound
      );
      return;
    }

    if (msg.type === 'CRAWL_COMPLETE') {
      showComplete(msg.results);
      return;
    }
  });

  // ─── Announce to Background ────────────────────────────────────────────────
  // Tell background.js this page is ready (after a short delay for DOM to settle)

  setTimeout(() => {
    chrome.runtime.sendMessage({ type: 'PAGE_READY' });
  }, 800);
})();
