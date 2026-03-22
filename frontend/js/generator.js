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
  const outputTypeSelect = document.getElementById('output-type');
  const slideOptions = document.getElementById('slide-options');

  // Show/hide slide count based on output type
  outputTypeSelect.addEventListener('change', () => {
    slideOptions.style.display = outputTypeSelect.value === 'slides' ? '' : 'none';
  });

  // Pre-fill from tracker
  let prefillAssignmentId = localStorage.getItem('prefill_assignment_id');
  const prefill = localStorage.getItem('prefill_assignment');
  if (prefill) {
    const textarea = document.getElementById('assignment-text');
    if (prefillAssignmentId) {
      textarea.value = `[Using deep-crawled content for: ${prefill}]\nAdd any extra notes here, or just click Generate.`;
      textarea.placeholder = 'Full assignment instructions, rubric, and course context will be pulled automatically.';
      // Auto-detect will work best with deep content
      outputTypeSelect.value = 'auto';
      slideOptions.style.display = 'none';
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
    const outputType = outputTypeSelect.value;
    const slideCount = document.getElementById('slide-count').value;
    const colorTheme = document.getElementById('color-theme').value;

    if (!assignmentText) {
      showError('Please enter your assignment instructions.');
      return;
    }

    formSection.classList.add('hidden');
    progressSection.style.display = 'block';
    progressText.textContent = 'Analyzing your assignment...';

    try {
      const { generationId } = await api.generate(assignmentText, slideCount, colorTheme, prefillAssignmentId || null, outputType);
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
      'Generating content with AI...',
      'Building your document...',
      'Formatting and polishing...',
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
          showDownloads(id, status.output_type || 'slides');
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

  function showDownloads(id, outputType) {
    progressSection.style.display = 'none';
    downloadSection.style.display = 'block';

    const token = api.getToken();

    // Show relevant download buttons based on output type
    if (outputType === 'slides') {
      pptxBtn.classList.remove('hidden');
      pptxBtn.textContent = 'Download PowerPoint (.pptx)';
      pptxBtn.onclick = () => downloadFile(id, 'pptx', token);
      docxBtn.classList.remove('hidden');
      docxBtn.textContent = 'Download Speaker Script (.docx)';
      docxBtn.classList.replace('btn-primary', 'btn-outline');
      docxBtn.onclick = () => downloadFile(id, 'docx', token);
    } else {
      // Written assignment — DOCX is the primary download
      docxBtn.classList.remove('hidden');
      docxBtn.textContent = 'Download Document (.docx)';
      docxBtn.onclick = () => downloadFile(id, 'docx', token);
      pptxBtn.classList.add('hidden');
    }
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
    a.download = `assignment.${type}`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  newGenBtn.addEventListener('click', () => {
    downloadSection.style.display = 'none';
    formSection.classList.remove('hidden');
    pptxBtn.classList.add('hidden');
    docxBtn.classList.add('hidden');
    form.reset();
    prefillAssignmentId = null;
    slideOptions.style.display = '';
  });

  function showError(msg) {
    errorAlert.innerHTML = msg;
    errorAlert.classList.remove('hidden');
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
});
