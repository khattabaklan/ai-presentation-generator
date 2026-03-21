// Dashboard page logic — requires api.js and auth.js

document.addEventListener('DOMContentLoaded', async () => {
  if (!auth.requireAuth()) return;

  const userInfo = document.getElementById('user-info');
  const statsRow = document.getElementById('stats-row');
  const historyBody = document.getElementById('history-body');
  const emptyState = document.getElementById('empty-state');

  try {
    const [{ user }, { generations }] = await Promise.all([api.getMe(), api.getHistory()]);

    // Update stored user
    api.setUser(user);

    // User info
    userInfo.textContent = user.email;

    // Stats
    const completed = generations.filter((g) => g.status === 'completed').length;
    const statusText =
      user.subscription_status === 'active'
        ? 'Pro'
        : `Free (${user.free_generations_used}/1 used)`;

    statsRow.innerHTML = `
      <div class="card stat-card">
        <div class="value">${generations.length}</div>
        <div class="label">Total Generations</div>
      </div>
      <div class="card stat-card">
        <div class="value">${completed}</div>
        <div class="label">Completed</div>
      </div>
      <div class="card stat-card">
        <div class="value">${statusText}</div>
        <div class="label">Plan</div>
      </div>
    `;

    // History
    if (generations.length === 0) {
      emptyState.classList.remove('hidden');
    } else {
      historyBody.innerHTML = generations
        .map(
          (g) => `
        <tr>
          <td>#${g.id}</td>
          <td>${g.slide_count} slides</td>
          <td>${g.color_theme}</td>
          <td><span class="status-badge status-${g.status}">${g.status}</span></td>
          <td>${new Date(g.created_at).toLocaleDateString()}</td>
          <td>
            ${
              g.status === 'completed'
                ? `<a href="#" onclick="downloadFromDashboard(${g.id}, 'pptx')">PPTX</a> |
                 <a href="#" onclick="downloadFromDashboard(${g.id}, 'docx')">DOCX</a>`
                : '—'
            }
          </td>
        </tr>
      `
        )
        .join('');
    }
  } catch (err) {
    console.error('Dashboard load error:', err);
    if (err.status === 401) {
      auth.logout();
    }
  }
});

async function downloadFromDashboard(id, type) {
  const token = api.getToken();
  const url = api.getDownloadUrl(id, type);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    alert('Download failed.');
    return;
  }

  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `presentation.${type}`;
  a.click();
  URL.revokeObjectURL(a.href);
}
