// ─── Deep Crawl Content Script ───────────────────────────────────────────────
// Runs on Brightspace pages. Scrolls through each page visually,
// highlights elements, extracts text, sends to background.js for Claude parsing.

(() => {
  const isBrightspace =
    window.location.href.includes('/d2l/') || window.location.href.includes('brightspace');
  if (!isBrightspace) return;

  console.log('[AA] Content script loaded:', window.location.href);

  // ─── Overlay (Shadow DOM) ─────────────────────────────────────────────────

  let overlayHost, overlayRoot, statusEl, progressEl, statsEl;

  function createOverlay() {
    if (overlayHost) return;
    overlayHost = document.createElement('div');
    overlayHost.id = 'aa-overlay';
    overlayRoot = overlayHost.attachShadow({ mode: 'closed' });
    overlayRoot.innerHTML = `
      <style>
        :host { all:initial; position:fixed; bottom:20px; right:20px; z-index:2147483647; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
        .p { background:#0f1117; border:1px solid #6366f1; border-radius:12px; padding:16px; width:320px; color:#e4e4e7; box-shadow:0 8px 32px rgba(99,102,241,.3); animation:si .3s ease-out; }
        @keyframes si { from{transform:translateY(20px);opacity:0} to{transform:translateY(0);opacity:1} }
        .h { display:flex; align-items:center; gap:8px; margin-bottom:12px; }
        .d { width:8px; height:8px; background:#6366f1; border-radius:50%; animation:pu 1.5s infinite; }
        @keyframes pu { 0%,100%{box-shadow:0 0 0 0 rgba(99,102,241,.4)} 50%{box-shadow:0 0 0 6px rgba(99,102,241,0)} }
        .t { font-size:13px; font-weight:600; color:#fff; }
        .s { font-size:12px; color:#a5b4fc; margin-bottom:8px; min-height:16px; }
        .b { width:100%; height:4px; background:#27272a; border-radius:2px; overflow:hidden; margin-bottom:8px; }
        .f { height:100%; background:linear-gradient(90deg,#6366f1,#8b5cf6); border-radius:2px; transition:width .4s; width:0%; }
        .st { font-size:11px; color:#71717a; }
        .done .d { background:#22c55e; animation:none; }
        .done .f { background:#22c55e; width:100%!important; }
        .done .s { color:#22c55e; }
      </style>
      <div class="p" id="panel">
        <div class="h"><div class="d"></div><div class="t">Academic Assistant</div></div>
        <div class="s" id="status">Preparing...</div>
        <div class="b"><div class="f" id="progress"></div></div>
        <div class="st" id="stats"></div>
      </div>`;
    document.body.appendChild(overlayHost);
    statusEl = overlayRoot.getElementById('status');
    progressEl = overlayRoot.getElementById('progress');
    statsEl = overlayRoot.getElementById('stats');
  }

  function updateOverlay(msg, done, total, courses, assignments) {
    if (!overlayHost) createOverlay();
    if (statusEl) statusEl.textContent = msg || 'Working...';
    if (progressEl && total > 0) progressEl.style.width = Math.min(100, Math.round(done / total * 100)) + '%';
    if (statsEl) {
      const p = [];
      if (courses > 0) p.push(courses + ' courses');
      if (assignments > 0) p.push(assignments + ' assignments');
      if (done > 0) p.push(done + '/' + total + ' pages');
      statsEl.textContent = p.join(' · ');
    }
  }

  function showComplete(r) {
    if (!overlayHost) createOverlay();
    overlayRoot.getElementById('panel')?.classList.add('done');
    if (statusEl) statusEl.textContent = 'Deep scan complete!';
    if (statsEl) statsEl.textContent = `${r.courses} courses · ${r.assignments} assignments · ${r.quizzes} quizzes · ${r.materials} topics`;
    setTimeout(() => { if (overlayHost?.parentNode) { overlayHost.style.transition='opacity .5s'; overlayHost.style.opacity='0'; setTimeout(()=>overlayHost.remove(),500); } }, 5000);
  }

  // ─── Highlight Style ──────────────────────────────────────────────────────

  const style = document.createElement('style');
  style.textContent = `.aa-hl{outline:2px solid #6366f1!important;outline-offset:2px!important;box-shadow:0 0 12px rgba(99,102,241,.4)!important;transition:all .3s!important;}`;
  document.head.appendChild(style);

  function highlight(selector) {
    document.querySelectorAll(selector).forEach(el => el.classList.add('aa-hl'));
  }
  function clearHL() {
    document.querySelectorAll('.aa-hl').forEach(el => el.classList.remove('aa-hl'));
  }

  // ─── Scroll ───────────────────────────────────────────────────────────────

  function scrollDown() {
    return new Promise(resolve => {
      const max = document.documentElement.scrollHeight;
      const step = Math.floor(window.innerHeight * 0.7);
      let pos = 0;
      (function go() {
        pos += step;
        if (pos >= max) { window.scrollTo({top:max,behavior:'smooth'}); setTimeout(resolve,400); return; }
        window.scrollTo({top:pos,behavior:'smooth'});
        setTimeout(go, 500);
      })();
    });
  }

  // ─── Text Extraction ─────────────────────────────────────────────────────

  function extractText() {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('script,style,svg,iframe,img,noscript,link,meta,#aa-overlay').forEach(e=>e.remove());
    let text = (clone.innerText || clone.textContent || '').replace(/\n{3,}/g,'\n\n').replace(/[ \t]{2,}/g,' ').trim();

    // Append all d2l links with labels — critical for Claude to find URLs
    const links = [];
    document.querySelectorAll('a[href*="/d2l/"]').forEach(a => {
      const href = a.getAttribute('href');
      const label = a.textContent.trim();
      if (href && label && label.length > 1) links.push(`[LINK: "${label}" → ${href}]`);
    });
    if (links.length > 0) text += '\n\n─── PAGE LINKS ───\n' + links.join('\n');
    return text;
  }

  // ─── Deep DOM Course Search ───────────────────────────────────────────────

  function findAllLinks(root, selector) {
    const results = [...root.querySelectorAll(selector)];
    root.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) results.push(...findAllLinks(el.shadowRoot, selector));
    });
    try {
      root.querySelectorAll('iframe').forEach(f => {
        if (f.contentDocument) results.push(...findAllLinks(f.contentDocument, selector));
      });
    } catch(e) {}
    return results;
  }

  function extractCourses() {
    const courses = [], seen = new Set();

    // Method 1: Deep DOM search for /d2l/home/{id} links
    findAllLinks(document, 'a[href*="/d2l/home/"]').forEach(link => {
      const match = (link.getAttribute('href')||'').match(/\/d2l\/home\/(\d+)/);
      if (!match) return;
      const id = match[1];
      if (seen.has(id)) return;
      seen.add(id);

      let name = link.textContent.trim();
      if (!name || name.length < 3) {
        let p = link.parentElement;
        for (let i=0; i<5&&p; i++) {
          const t = p.textContent.trim();
          if (t.length > 3 && t.length < 300) { name = t.split('\n').filter(l=>l.trim().length>2)[0]?.trim()||t.substring(0,200); break; }
          p = p.parentElement;
        }
      }
      if (!name || name.length < 3) return;
      name = name.split('\n')[0].trim().substring(0,200);
      const code = name.match(/\(([A-Z]{2,5}[-\s]?\d{3,5}[A-Za-z0-9-]*)\)/);
      courses.push({ courseId:id, name, code:code?code[1].trim():null, url:`${location.origin}/d2l/home/${id}` });
    });

    // Method 2: Regex fallback on raw HTML
    if (courses.length === 0) {
      console.log('[AA] DOM search failed, trying HTML regex');
      const html = document.documentElement.innerHTML;
      const re = /\/d2l\/home\/(\d{4,})/g;
      let m;
      while ((m = re.exec(html)) !== null) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        courses.push({ courseId:m[1], name:`Course ${m[1]}`, code:null, url:`${location.origin}/d2l/home/${m[1]}` });
      }
    }

    // Method 3: Look for course names near IDs in page text
    if (courses.length > 0 && courses[0].name.startsWith('Course ')) {
      // Try to find better names from the page
      const text = document.body.innerText;
      courses.forEach(c => {
        // Look for the course ID near a course-like name
        const nameMatch = text.match(new RegExp(`([A-Z][^\\n]{5,80})\\s*.*${c.courseId}|${c.courseId}.*?([A-Z][^\\n]{5,80})`));
        if (nameMatch) c.name = (nameMatch[1] || nameMatch[2]).trim().substring(0,200);
      });
    }

    console.log('[AA] Courses found:', courses.length, courses);
    return courses;
  }

  // ─── Actions ──────────────────────────────────────────────────────────────

  const actions = {
    async extract_courses(progress) {
      updateOverlay('Finding your courses...', 0, 1, 0, 0);
      await new Promise(r => setTimeout(r, 3000));
      await scrollDown();
      await new Promise(r => setTimeout(r, 1500));

      let courses = [];
      for (let i = 0; i < 3 && courses.length === 0; i++) {
        courses = extractCourses();
        if (courses.length > 0) break;
        console.log(`[AA] Attempt ${i+1}: no courses, retrying...`);
        await new Promise(r => setTimeout(r, 2000));
        window.scrollTo({top:0,behavior:'smooth'});
        await new Promise(r => setTimeout(r, 500));
        await scrollDown();
        await new Promise(r => setTimeout(r, 1000));
      }

      highlight('a[href*="/d2l/home/"]');
      await new Promise(r => setTimeout(r, 800));
      clearHL();
      window.scrollTo({top:0,behavior:'smooth'});

      chrome.runtime.sendMessage({
        type: 'PAGE_DATA',
        payload: { pageType: 'courses', directData: { courses } },
      });
    },

    async read_page(progress, data) {
      const { pageType } = data;
      updateOverlay(`Reading ${pageType.replace(/_/g,' ')}...`, progress.pagesCompleted, progress.totalPages, progress.coursesFound, progress.assignmentsFound);
      await new Promise(r => setTimeout(r, 1500));

      // Highlight relevant elements
      const selectors = {
        course_content: '.d2l-le-TreeAccordion, [class*="module"], [class*="content-toc"], [class*="d2l-le-Content"]',
        assignments_list: '.d2l-datalist-item, tr[class*="d2l"], a[href*="dropbox"], a[href*="folder"], td a',
        assignment_detail: '.d2l-htmlblock, .d2l-richtext, [class*="instructions"], [class*="rubric"], .d2l-box',
        quizzes: 'a[href*="quiz"], .d2l-datalist-item, tr[class*="d2l"], td a',
      };
      if (selectors[pageType]) highlight(selectors[pageType]);

      await scrollDown();
      await new Promise(r => setTimeout(r, 800));

      const text = extractText();
      clearHL();
      window.scrollTo({top:0,behavior:'smooth'});

      chrome.runtime.sendMessage({
        type: 'PAGE_DATA',
        payload: { text, pageType },
      });
    },
  };

  // ─── Message Listener ─────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'CRAWL_ACTION') {
      console.log('[AA] Action:', msg.action, msg.data);
      createOverlay();
      if (actions[msg.action]) actions[msg.action](msg.progress || {}, msg.data || {});
      sendResponse({ ok: true });
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

  // ─── Announce ─────────────────────────────────────────────────────────────

  setTimeout(() => chrome.runtime.sendMessage({ type: 'PAGE_READY' }), 800);
})();
