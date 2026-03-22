const API_BASE = 'https://backend-production-2c4d.up.railway.app'; // Railway production URL

const api = {
  getToken() {
    return localStorage.getItem('token');
  },

  setToken(token) {
    localStorage.setItem('token', token);
  },

  clearToken() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
  },

  getUser() {
    const raw = localStorage.getItem('user');
    return raw ? JSON.parse(raw) : null;
  },

  setUser(user) {
    localStorage.setItem('user', JSON.stringify(user));
  },

  async request(path, options = {}) {
    const token = this.getToken();
    const headers = { ...options.headers };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    if (options.body && typeof options.body === 'object') {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }

    const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    const data = await res.json();

    if (!res.ok) {
      const error = new Error(data.error || 'Request failed');
      error.status = res.status;
      error.data = data;
      throw error;
    }

    return data;
  },

  // Auth
  signup(email, password) {
    return this.request('/auth/signup', {
      method: 'POST',
      body: { email, password },
    });
  },

  login(email, password) {
    return this.request('/auth/login', {
      method: 'POST',
      body: { email, password },
    });
  },

  getMe() {
    return this.request('/auth/me');
  },

  // Generation
  generate(assignmentText, slideCount, colorTheme, assignmentId) {
    const body = { assignmentText, slideCount, colorTheme };
    if (assignmentId) body.assignmentId = assignmentId;
    return this.request('/generate', {
      method: 'POST',
      body,
    });
  },

  getGenerationStatus(id) {
    return this.request(`/generate/${id}/status`);
  },

  getDownloadUrl(id, type) {
    return `${API_BASE}/generate/${id}/download/${type}`;
  },

  // History
  getHistory() {
    return this.request('/history');
  },

  // Billing
  createCheckout() {
    return this.request('/billing/checkout', { method: 'POST' });
  },

  // Tracker
  trackerSaveCredentials(lmsUrl, username, password, platform = 'brightspace') {
    return this.request('/tracker/credentials', {
      method: 'POST',
      body: { lmsUrl, username, password, platform },
    });
  },

  trackerGetCredentials() {
    return this.request('/tracker/credentials');
  },

  trackerDeleteCredentials() {
    return this.request('/tracker/credentials', { method: 'DELETE' });
  },

  trackerStartSync(platform = 'brightspace') {
    return this.request('/tracker/sync', {
      method: 'POST',
      body: { platform },
    });
  },

  trackerGetSyncStatus(syncId) {
    return this.request(`/tracker/sync/${syncId}`);
  },

  trackerGetAssignments() {
    return this.request('/tracker/assignments');
  },

  trackerGetCourses() {
    return this.request('/tracker/courses');
  },

  trackerGetSummary() {
    return this.request('/tracker/summary');
  },
};
