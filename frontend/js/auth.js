// Auth utilities — login disabled, app is free and open for now

const auth = {
  isLoggedIn() {
    return true;
  },

  logout() {
    // No-op — login disabled
  },

  requireAuth() {
    return true;
  },

  redirectIfLoggedIn() {
    // No-op — login disabled
  },

  updateNavbar() {
    const navLinks = document.getElementById('nav-links');
    if (!navLinks) return;

    navLinks.innerHTML = `
      <li><a href="app.html">Generator</a></li>
      <li><a href="tracker.html">Tracker</a></li>
      <li><a href="dashboard.html">History</a></li>
    `;
  },
};

// Update navbar on every page load
document.addEventListener('DOMContentLoaded', () => {
  auth.updateNavbar();
});
