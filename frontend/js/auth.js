// Auth utilities — requires api.js to be loaded first

const auth = {
  isLoggedIn() {
    return !!api.getToken();
  },

  logout() {
    api.clearToken();
    window.location.href = 'index.html';
  },

  requireAuth() {
    if (!this.isLoggedIn()) {
      window.location.href = 'login.html';
      return false;
    }
    return true;
  },

  redirectIfLoggedIn() {
    if (this.isLoggedIn()) {
      window.location.href = 'app.html';
    }
  },

  updateNavbar() {
    const navLinks = document.getElementById('nav-links');
    if (!navLinks) return;

    if (this.isLoggedIn()) {
      const user = api.getUser();
      navLinks.innerHTML = `
        <li><a href="app.html">Generator</a></li>
        <li><a href="tracker.html">Tracker</a></li>
        <li><a href="dashboard.html">Dashboard</a></li>
        <li><a href="pricing.html">Pricing</a></li>
        <li><a href="#" id="logout-link">Logout</a></li>
      `;
      document.getElementById('logout-link').addEventListener('click', (e) => {
        e.preventDefault();
        this.logout();
      });
    } else {
      navLinks.innerHTML = `
        <li><a href="index.html">Home</a></li>
        <li><a href="pricing.html">Pricing</a></li>
        <li><a href="login.html">Login</a></li>
        <li><a href="signup.html" class="btn btn-primary" style="padding: 8px 20px;">Sign Up</a></li>
      `;
    }
  },
};

// Update navbar on every page load
document.addEventListener('DOMContentLoaded', () => {
  auth.updateNavbar();
});
