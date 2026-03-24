// ─── Popup: Trigger & Monitor Deep Crawl ─────────────────────────────────────
// Simple UI that messages background.js to start/monitor the crawl.

const contentEl = document.getElementById('content');
let pollInterval = null;

// Check current state on popup open
chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
  if (!tab?.url) {
    showNotBrightspace();
    return;
  }

  const isBrightspace = tab.url.includes('/d2l/') || tab.url.includes('brightspace');
  if (!isBrightspace) {
    showNotBrightspace();
    return;
  }

  // Check if a crawl is already running
  chrome.runtime.sendMessage({ type: 'GET_CRAWL_STATUS' }, (status) => {
    if (status?.active) {
      showProgress(status);
      startPolling();
    } else if (status?.phase === 'done') {
      showDone(status);
    } else if (status?.phase === 'error') {
      showError(status.error);
    } else {
      showReady(tab);
    }
  });
});

// Listen for live progress updates from background.js
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'CRAWL_PROGRESS') {
    showProgress(msg);
  }
});

function showNotBrightspace() {
  contentEl.innerHTML = `
    <div class="not-brightspace">
      <strong>Navigate to Brightspace first</strong>
      Open your university's Brightspace homepage, then click this extension to start a deep scan.
    </div>
  `;
}

function showReady(tab) {
  contentEl.innerHTML = `
    <div class="status">
      <strong>Ready to scan</strong>
      <div class="detail">This will navigate through your courses, assignments, quizzes, and materials. You'll see it scrolling through each page.</div>
    </div>
    <button id="sync-btn">Start Deep Scan</button>
  `;

  document.getElementById('sync-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({
      type: 'START_DEEP_CRAWL',
      tabId: tab.id,
      baseUrl: tab.url,
    });
    showProgress({ message: 'Starting deep scan...', pagesCompleted: 0, totalPages: 1 });
    startPolling();
  });
}

function showProgress(data) {
  const pct = data.totalPages > 0
    ? Math.min(100, Math.round((data.pagesCompleted / data.totalPages) * 100))
    : 5;

  const stats = [];
  if (data.coursesFound > 0) stats.push(`${data.coursesFound} courses`);
  if (data.assignmentsFound > 0) stats.push(`${data.assignmentsFound} assignments`);

  contentEl.innerHTML = `
    <div class="status syncing">
      ${data.message || data.phase || 'Scanning...'}
      <div class="progress-bar"><div class="progress-fill" style="width: ${pct}%"></div></div>
      <div class="detail">${stats.join(' · ')}${data.currentCourse ? ' · ' + data.currentCourse : ''}</div>
    </div>
    <button id="cancel-btn" class="cancel">Cancel Scan</button>
  `;

  const cancelBtn = document.getElementById('cancel-btn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'CANCEL_CRAWL' });
      stopPolling();
      chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        showReady(tab || { id: null, url: '' });
      });
    });
  }
}

function showDone(status) {
  stopPolling();
  contentEl.innerHTML = `
    <div class="status success">
      <strong>Deep scan complete!</strong>
      <div class="detail">${status.coursesFound || 0} courses · ${status.assignmentsFound || 0} assignments found</div>
    </div>
    <button id="sync-btn">Scan Again</button>
  `;
  document.getElementById('sync-btn').addEventListener('click', () => location.reload());
}

function showError(msg) {
  stopPolling();
  contentEl.innerHTML = `
    <div class="status error">
      ${msg || 'Scan failed'}
    </div>
    <button id="sync-btn">Try Again</button>
  `;
  document.getElementById('sync-btn').addEventListener('click', () => location.reload());
}

function startPolling() {
  stopPolling();
  pollInterval = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'GET_CRAWL_STATUS' }, (status) => {
      if (!status) return;
      if (status.phase === 'done') {
        showDone(status);
      } else if (status.phase === 'error') {
        showError(status.error);
      } else if (status.active) {
        // Progress is updated via the onMessage listener
      } else {
        stopPolling();
      }
    });
  }, 2000);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}
