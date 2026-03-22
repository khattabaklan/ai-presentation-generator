// Content script — detects Brightspace pages
// Minimal: just adds a marker so the popup knows Brightspace is loaded
if (document.querySelector('a[href*="/d2l/"]') || window.location.href.includes('/d2l/')) {
  document.documentElement.dataset.brightspaceDetected = 'true';
}
