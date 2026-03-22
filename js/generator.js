// Generator page logic — requires api.js and auth.js

document.addEventListener('DOMContentLoaded', () => {
  if (!auth.requireAuth()) return;

  const form = document.getElementById('generator-form');
  const formSection = document.getElementById('form-section');
  const progressSection = document.getElementById('progress-section');
  const downloadSection = document.getElementById('download-section');
  const progressText = document.getElementById('progress-text');
  const errorAlert = document.getElementById('error-alert');
  const pptxBtn = document.getElementById('download-pptx');
  const docxBtn = document.getElementById('download-docx');
  const newGenBtn = document.getElementById('new-generation');

  // Pre-fill from tracker if assignment data was passed
  let prefillAssignmentId = localStorage.getItem('prefill_assignment_id');
  const prefill = localStorage.getItem('prefill_assignment');
  if (prefill) {
    const textarea = document.getElementById('assignment-text');
    if (prefillAssignmentId) {
      textarea.value = `[Using deep-crawled content for: ${prefill}]\nAdd any extra notes here, or just click Generate.`;
      textarea.placeholder = 'Full assignment instructions, rubric, and course context will be pulled automatically from your synced data.';
    } else {
      textarea.value = prefill;
    }
    localStorage.removeItem('prefill_assignment');
    localStorage.removeItem('prefill_assignment_id');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorAlert.classList.add('hidden');

    const assignmentText = document.getElementById('assignment-text').value.trim();
    const slideCount = document.getElementById('slide-count').value;
    const colorTheme = document.getElementById('color-theme').value;

    if (!assignmentText) {
      showError('Please enter your assignment instructions.');
      return;
    }

    // Show progress
    formSection.classList.add('hidden');
    progressSection.style.display = 'block';
    progressText.textContent = 'Starting generation...';

    try {
      const { generationId } = await api.generate(assignmentText, slideCount, colorTheme, prefillAssignmentId || null);
      await pollStatus(generationId);
    } catch (err) {
      formSection.classList.remove('hidden');
      progressSection.style.display = 'none';

      if (err.status === 402) {
        showError('You\'ve used your free generation. <a href="pricing.html">Subscribe to Pro</a> for unlimited generations.');
      } else {
        showError(err.message || 'Generation failed. Please try again.');
      }
    }
  });

  async function pollStatus(id) {
    const messages = [
      'Analyzing your assignment...',
      'Generating slide content with AI...',
      'Building your presentation...',
      'Creating speaker script...',
      'Almost done...',
    ];
    let msgIndex = 0;

    const interval = setInterval(() => {
      msgIndex = Math.min(msgIndex + 1, messages.length - 1);
      progressText.textContent = messages[msgIndex];
    }, 5000);

    try {
      let attempts = 0;
      while (attempts < 60) {
        await sleep(2000);
        const status = await api.getGenerationStatus(id);

        if (status.status === 'completed') {
          clearInterval(interval);
          showDownloads(id);
          return;
        }

        if (status.status === 'failed') {
          clearInterval(interval);
          throw new Error('Generation failed. Please try again.');
        }

        attempts++;
      }

      clearInterval(interval);
      throw new Error('Generation timed out. Please try again.');
    } catch (err) {
      clearInterval(interval);
      progressSection.style.display = 'none';
      formSection.classList.remove('hidden');
      showError(err.message);
    }
  }

  function showDownloads(id) {
    progressSection.style.display = 'none';
    downloadSection.style.display = 'block';

    const token = api.getToken();

    pptxBtn.onclick = () => downloadFile(id, 'pptx', token);
    docxBtn.onclick = () => downloadFile(id, 'docx', token);
  }

  async function downloadFile(id, type, token) {
    const url = api.getDownloadUrl(id, type);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      showError('Download failed. Please try again.');
      return;
    }

    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `presentation.${type}`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  newGenBtn.addEventListener('click', () => {
    downloadSection.style.display = 'none';
    formSection.classList.remove('hidden');
    form.reset();
    prefillAssignmentId = null;
  });

  function showError(msg) {
    errorAlert.innerHTML = msg;
    errorAlert.classList.remove('hidden');
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
});
