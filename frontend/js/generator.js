// Generator page logic — requires api.js and auth.js

document.addEventListener('DOMContentLoaded', () => {
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
  const colorThemeGroup = document.getElementById('color-theme-group');

  // Show/hide slide-specific options based on output type
  outputTypeSelect.addEventListener('change', () => {
    const isSlides = outputTypeSelect.value === 'slides';
    if (slideOptions) slideOptions.style.display = isSlides ? '' : 'none';
    if (colorThemeGroup) colorThemeGroup.style.display = isSlides ? '' : 'none';
  });

  // Trigger initial state
  outputTypeSelect.dispatchEvent(new Event('change'));

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
      const { generationId } = await api.generate(assignmentText, slideCount, colorTheme, null, outputType);
      await pollStatus(generationId);
    } catch (err) {
      formSection.classList.remove('hidden');
      progressSection.style.display = 'none';
      showError(err.message || 'Generation failed. Please try again.');
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

    // Reset button classes
    pptxBtn.className = 'btn btn-primary btn-lg hidden';
    docxBtn.className = 'btn btn-primary btn-lg hidden';

    if (outputType === 'slides') {
      pptxBtn.classList.remove('hidden');
      pptxBtn.textContent = 'Download PowerPoint (.pptx)';
      pptxBtn.onclick = () => downloadFile(id, 'pptx');
      docxBtn.classList.remove('hidden');
      docxBtn.textContent = 'Download Notes (.docx)';
      docxBtn.classList.replace('btn-primary', 'btn-outline');
      docxBtn.onclick = () => downloadFile(id, 'docx');
    } else {
      docxBtn.classList.remove('hidden');
      docxBtn.textContent = 'Download Document (.docx)';
      docxBtn.onclick = () => downloadFile(id, 'docx');
    }
  }

  async function downloadFile(id, type) {
    try {
      const url = api.getDownloadUrl(id, type);
      const token = api.getToken();
      const headers = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch(url, { headers });
      if (!res.ok) {
        showError('Download failed. Please try again.');
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
      showError('Download failed: ' + (err.message || 'Unknown error'));
    }
  }

  newGenBtn.addEventListener('click', () => {
    downloadSection.style.display = 'none';
    formSection.classList.remove('hidden');
    pptxBtn.className = 'btn btn-primary btn-lg hidden';
    docxBtn.className = 'btn btn-primary btn-lg hidden';
    form.reset();
    outputTypeSelect.dispatchEvent(new Event('change'));
  });

  function showError(msg) {
    errorAlert.textContent = msg;
    errorAlert.classList.remove('hidden');
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
});
