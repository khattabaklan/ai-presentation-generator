// Dashboard page logic — requires api.js and auth.js

document.addEventListener('DOMContentLoaded', async () => {
  const userInfo = document.getElementById('user-info');
  const statsRow = document.getElementById('stats-row');
  const historyBody = document.getElementById('history-body');
  const emptyState = document.getElementById('empty-state');

  try {
    const { generations } = await api.getHistory();

    // User info
    userInfo.textContent = 'Guest';

    // Stats
    const completed = generations.filter((g) => g.status === 'completed').length;

    statsRow.innerHTML = `
      <div class="card stat-card">
        <div class="value">${generations.length}</div>
        <div class="label">Total Generations</div>
      </div>
      <div class="card stat-card">
        <div class="value">${completed}</div>
        <div class="label">Completed</div>
      </div>
    `;

    // History
    if (generations.length === 0) {
      emptyState.classList.remove('hidden');
    } else {
      historyBody.innerHTML = generations
        .map((g) => {
          const id = escapeHtml(String(g.id));
          const type = g.has_pptx ? 'Slides' : 'Document';
          const status = escapeHtml(g.status);
          const date = new Date(g.created_at).toLocaleDateString();
          let downloads = '—';

          if (g.status === 'completed') {
            const parts = [];
            if (g.has_pptx) parts.push(`<a href="#" class="dl-link" data-id="${id}" data-type="pptx">PPTX</a>`);
            parts.push(`<a href="#" class="dl-link" data-id="${id}" data-type="docx">DOCX</a>`);
            downloads = parts.join(' | ');
          }

          return `
            <tr>
              <td>#${id}</td>
              <td>${type}</td>
              <td><span class="status-badge status-${status}">${status}</span></td>
              <td>${date}</td>
              <td>${downloads}</td>
            </tr>
          `;
        })
        .join('');

      // Attach download handlers
      historyBody.querySelectorAll('.dl-link').forEach((link) => {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          downloadFromDashboard(link.dataset.id, link.dataset.type);
        });
      });
    }
  } catch (err) {
    console.error('Dashboard load error:', err);
    if (statsRow) {
      statsRow.innerHTML = '<div class="card stat-card"><div class="label">Failed to load data</div></div>';
    }
  }
});

async function downloadFromDashboard(id, type) {
  try {
    const token = api.getToken();
    const url = api.getDownloadUrl(id, type);
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(url, { headers });

    if (!res.ok) {
      alert('Download failed.');
      return;
    }

    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `assignment.${type}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(blobUrl);
  } catch (err) {
    alert('Download failed: ' + (err.message || 'Unknown error'));
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
