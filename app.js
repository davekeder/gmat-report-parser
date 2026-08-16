import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.149/build/pdf.min.mjs';
import { parseReportText, parseQuestionColumnText, reconcileQuestionIds, parseTimeToSeconds, formatTime } from './parser.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.149/build/pdf.worker.min.mjs';

const $ = (selector) => document.querySelector(selector);

const el = {
  pdfFile: $('#pdfFile'),
  fileName: $('#fileName'),
  analyzeBtn: $('#analyzeBtn'),
  progressWrap: $('#progressWrap'),
  progressBar: $('#progressBar'),
  progressText: $('#progressText'),
  statusBox: $('#statusBox'),
  resultsArea: $('#resultsArea'),
  timingMode: $('#timingMode'),
  correctStat: $('#correctStat'),
  questionStat: $('#questionStat'),
  totalTimeStat: $('#totalTimeStat'),
  paceStat: $('#paceStat'),
  chartCanvas: $('#pacingChart'),
  saveChartBtn: $('#saveChartBtn'),
  selectedFilters: $('#selectedFilters'),
  includeIncorrect: $('#includeIncorrect'),
  includeSlowCorrect: $('#includeSlowCorrect'),
  cutoffTime: $('#cutoffTime'),
  idOutput: $('#idOutput'),
  copyBtn: $('#copyBtn'),
  selectionCount: $('#selectionCount'),
  verificationBody: $('#verificationBody'),
  ocrText: $('#ocrText'),
  questionOcrText: $('#questionOcrText'),
};

const state = {
  questions: [],
  detectedTotalSeconds: null,
  detectedScore: null,
  rawText: '',
  questionOcrText: '',
  ocrDisagreements: 0,
  chart: null,
};

function setProgress(percent, text) {
  el.progressWrap.hidden = false;
  el.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  el.progressText.textContent = text;
}

function hideProgress() {
  el.progressWrap.hidden = true;
  el.progressBar.style.width = '0%';
}

function showStatus(message, type = 'success') {
  el.statusBox.hidden = false;
  el.statusBox.className = `status-box ${type}`;
  el.statusBox.textContent = message;
}

function getSelectedTotalSeconds() {
  const value = el.timingMode.value;
  if (value === 'auto') return state.detectedTotalSeconds ?? 2700;
  return Number(value);
}

function formatTotalTime(seconds) {
  return formatTime(seconds);
}

async function renderSummaryPage(file) {
  setProgress(8, 'Opening PDF…');
  const bytes = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const page = await pdf.getPage(1);

  setProgress(17, 'Rendering summary page…');
  const scale = 2.8;
  const viewport = page.getViewport({ scale });
  const pageCanvas = document.createElement('canvas');
  pageCanvas.width = Math.ceil(viewport.width);
  pageCanvas.height = Math.ceil(viewport.height);
  const ctx = pageCanvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;

  // GMAT timed-practice PDFs place the summary table in the upper portion of page 1.
  const summaryCanvas = document.createElement('canvas');
  summaryCanvas.width = pageCanvas.width;
  summaryCanvas.height = Math.floor(pageCanvas.height * 0.70);
  const summaryCtx = summaryCanvas.getContext('2d', { alpha: false });
  summaryCtx.fillStyle = '#ffffff';
  summaryCtx.fillRect(0, 0, summaryCanvas.width, summaryCanvas.height);
  summaryCtx.drawImage(
    pageCanvas,
    0, 0, summaryCanvas.width, summaryCanvas.height,
    0, 0, summaryCanvas.width, summaryCanvas.height,
  );

  // Second OCR pass: tightly crop the Question column, enlarge it, and remove
  // the alternating gray row background. No character whitelist is used, so
  // IDs containing letters, numbers, dashes, or other punctuation are allowed.
  const sourceX = Math.floor(pageCanvas.width * 0.10);
  const sourceY = Math.floor(pageCanvas.height * 0.105);
  const sourceW = Math.floor(pageCanvas.width * 0.155);
  const sourceH = Math.floor(pageCanvas.height * 0.515);
  const upscale = 2;

  const questionCanvas = document.createElement('canvas');
  questionCanvas.width = sourceW * upscale;
  questionCanvas.height = sourceH * upscale;
  const questionCtx = questionCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
  questionCtx.fillStyle = '#ffffff';
  questionCtx.fillRect(0, 0, questionCanvas.width, questionCanvas.height);
  questionCtx.imageSmoothingEnabled = true;
  questionCtx.drawImage(
    pageCanvas,
    sourceX, sourceY, sourceW, sourceH,
    0, 0, questionCanvas.width, questionCanvas.height,
  );

  const image = questionCtx.getImageData(0, 0, questionCanvas.width, questionCanvas.height);
  for (let i = 0; i < image.data.length; i += 4) {
    const r = image.data[i];
    const g = image.data[i + 1];
    const b = image.data[i + 2];
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    const value = luminance < 210 ? 0 : 255;
    image.data[i] = value;
    image.data[i + 1] = value;
    image.data[i + 2] = value;
    image.data[i + 3] = 255;
  }
  questionCtx.putImageData(image, 0, 0);

  return { summaryCanvas, questionCanvas };
}

async function runOcrPasses(summaryCanvas, questionCanvas) {
  setProgress(24, 'Loading OCR engine…');
  let phase = 'summary';
  const worker = await Tesseract.createWorker('eng', 1, {
    logger: (message) => {
      if (message.status !== 'recognizing text') return;
      const progress = message.progress || 0;
      if (phase === 'summary') {
        const pct = 28 + Math.round(progress * 45);
        setProgress(pct, `Reading summary table… ${Math.round(progress * 100)}%`);
      } else {
        const pct = 75 + Math.round(progress * 18);
        setProgress(pct, `Cross-checking Question IDs… ${Math.round(progress * 100)}%`);
      }
    },
  });

  try {
    // Keep the primary pass identical to v1.0. It was already parsing the
    // GMAT summary table reliably, so do not force a page-segmentation mode.
    await worker.setParameters({
      preserve_interword_spaces: '1',
    });
    const summaryResult = await worker.recognize(summaryCanvas);

    phase = 'question';
    await worker.setParameters({
      preserve_interword_spaces: '1',
      tessedit_pageseg_mode: '6',
    });
    const questionResult = await worker.recognize(questionCanvas);

    return {
      summaryText: summaryResult.data.text,
      questionText: questionResult.data.text,
    };
  } finally {
    await worker.terminate();
  }
}
async function retrySummaryOcr(summaryCanvas) {
  setProgress(94, 'Retrying summary-table layout…');
  const worker = await Tesseract.createWorker('eng', 1);
  try {
    await worker.setParameters({
      preserve_interword_spaces: '1',
      tessedit_pageseg_mode: '6',
    });
    const result = await worker.recognize(summaryCanvas);
    return result.data.text;
  } finally {
    await worker.terminate();
  }
}

async function analyzePdf() {
  const file = el.pdfFile.files?.[0];
  if (!file) return;

  el.analyzeBtn.disabled = true;
  el.statusBox.hidden = true;
  el.resultsArea.hidden = true;

  try {
    const { summaryCanvas, questionCanvas } = await renderSummaryPage(file);
    const { summaryText, questionText } = await runOcrPasses(summaryCanvas, questionCanvas);
    setProgress(95, 'Parsing and cross-checking question data…');

    let parsed = parseReportText(summaryText);

    // If the normal v1-style pass fails (or clearly misses rows), retry once
    // with a single-block layout. This mode reads the sample GMAT table as
    // complete rows and is only invoked as a fallback, so normal runs stay fast.
    const primaryLooksIncomplete = !parsed.questions.length
      || (parsed.detectedScore && parsed.questions.length !== parsed.detectedScore.total);
    if (primaryLooksIncomplete) {
      const retryText = await retrySummaryOcr(summaryCanvas);
      const retryParsed = parseReportText(retryText);
      const retryIsBetter = retryParsed.questions.length > parsed.questions.length
        || (retryParsed.detectedScore
          && retryParsed.questions.length === retryParsed.detectedScore.total
          && parsed.questions.length !== parsed.detectedScore?.total);
      if (retryIsBetter) parsed = retryParsed;
    }

    if (!parsed.questions.length) {
      throw new Error('I could not find question rows on the first page. The app retried the summary layout automatically but still could not parse this report.');
    }

    const targeted = parseQuestionColumnText(questionText);
    const reconciled = reconcileQuestionIds(parsed.questions, targeted.ids);

    state.questions = reconciled.questions;
    state.detectedTotalSeconds = parsed.detectedTotalSeconds;
    state.detectedScore = parsed.detectedScore;
    state.rawText = parsed.text;
    state.questionOcrText = targeted.text;
    state.ocrDisagreements = reconciled.disagreements;

    el.ocrText.textContent = parsed.text;
    el.questionOcrText.textContent = targeted.text;
    el.timingMode.value = 'auto';
    renderVerificationTable();
    refreshEverything();
    el.resultsArea.hidden = false;

    setProgress(100, 'Done');
    const baseMessage = `Found ${state.questions.length} questions${state.detectedTotalSeconds ? ` and detected ${formatTotalTime(state.detectedTotalSeconds)} total time` : ''}.`;
    const allWarnings = [...parsed.warnings, ...reconciled.warnings];
    if (state.ocrDisagreements) {
      allWarnings.push(`${state.ocrDisagreements} Question ID${state.ocrDisagreements === 1 ? '' : 's'} differed between the two OCR passes and ${state.ocrDisagreements === 1 ? 'is' : 'are'} highlighted below.`);
    }
    if (allWarnings.length) {
      showStatus(`${baseMessage} ${allWarnings.join(' ')}`, 'warning');
    } else {
      showStatus(`${baseMessage} Both OCR passes agree on every Question ID.`, 'success');
    }

    setTimeout(hideProgress, 450);
    el.resultsArea.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    console.error(error);
    hideProgress();
    showStatus(error?.message || 'Unable to analyze this PDF.', 'error');
  } finally {
    el.analyzeBtn.disabled = false;
  }
}

function renderVerificationTable() {
  el.verificationBody.innerHTML = '';

  state.questions.forEach((question, index) => {
    const row = document.createElement('tr');
    row.className = `${question.result === 'Correct' ? 'row-correct' : 'row-incorrect'}${question.ocrCheck?.status === 'review' ? ' row-review' : ''}`;
    const ocrCheckHtml = buildOcrCheckHtml(question, index);
    row.innerHTML = `
      <td>${index + 1}</td>
      <td class="id-cell"><input class="table-input id-editor" value="${escapeHtml(question.id)}" aria-label="Question ${index + 1} ID" /></td>
      <td class="ocr-check-cell">${ocrCheckHtml}</td>
      <td class="result-cell">
        <select class="table-select result-editor" aria-label="Question ${index + 1} result">
          <option value="Correct" ${question.result === 'Correct' ? 'selected' : ''}>Correct</option>
          <option value="Incorrect" ${question.result === 'Incorrect' ? 'selected' : ''}>Incorrect</option>
        </select>
      </td>
      <td class="time-cell"><input class="table-input time-editor" value="${formatTime(question.seconds)}" inputmode="numeric" aria-label="Question ${index + 1} time" /></td>
    `;

    const idEditor = row.querySelector('.id-editor');
    const resultEditor = row.querySelector('.result-editor');
    const timeEditor = row.querySelector('.time-editor');

    idEditor.addEventListener('change', () => {
      question.id = idEditor.value.trim().toUpperCase();
      idEditor.value = question.id;
      if (question.ocrCheck) {
        question.ocrCheck.status = 'single';
        question.ocrCheck.alternateId = null;
        question.ocrCheck.selectedSource = 'manual';
        row.classList.remove('row-review');
        row.querySelector('.ocr-check-cell').innerHTML = '<span class="ocr-badge manual">Edited</span>';
      }
      refreshEverything();
    });

    resultEditor.addEventListener('change', () => {
      question.result = resultEditor.value;
      row.className = `${question.result === 'Correct' ? 'row-correct' : 'row-incorrect'}${question.ocrCheck?.status === 'review' ? ' row-review' : ''}`;
      refreshEverything();
    });

    timeEditor.addEventListener('change', () => {
      const parsed = parseTimeToSeconds(timeEditor.value);
      if (parsed === null) {
        timeEditor.value = formatTime(question.seconds);
        timeEditor.setCustomValidity('Use m:ss, for example 2:30.');
        timeEditor.reportValidity();
        timeEditor.setCustomValidity('');
        return;
      }
      question.seconds = parsed;
      timeEditor.value = formatTime(parsed);
      refreshEverything();
    });

    attachOcrSuggestionHandler(row, question);
    el.verificationBody.appendChild(row);
  });
}

function buildOcrCheckHtml(question, index) {
  const check = question.ocrCheck;
  if (!check || check.status === 'single') {
    return '<span class="ocr-badge single">Single pass</span>';
  }
  if (check.status === 'match') {
    return '<span class="ocr-badge match">✓ Match</span>';
  }

  const sourceLabel = check.selectedSource === 'targeted' ? 'Targeted read selected' : 'Full-page read selected';
  return `
    <div class="ocr-review-wrap">
      <span class="ocr-badge review">Review</span>
      <span class="ocr-source">${escapeHtml(sourceLabel)}</span>
      <button class="ocr-alt-btn" type="button" data-row="${index}" title="Use the other OCR reading">Use ${escapeHtml(check.alternateId)}</button>
    </div>
  `;
}

function attachOcrSuggestionHandler(row, question) {
  const button = row.querySelector('.ocr-alt-btn');
  if (!button || !question.ocrCheck?.alternateId) return;
  button.addEventListener('click', () => {
    const currentId = question.id;
    question.id = question.ocrCheck.alternateId;
    question.ocrCheck.alternateId = currentId;
    question.ocrCheck.selectedSource = question.ocrCheck.selectedSource === 'targeted' ? 'full' : 'targeted';

    row.querySelector('.id-editor').value = question.id;
    const cell = row.querySelector('.ocr-check-cell');
    cell.innerHTML = buildOcrCheckHtml(question, question.number - 1);
    attachOcrSuggestionHandler(row, question);
    refreshEverything();
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function refreshStats() {
  const n = state.questions.length;
  const correct = state.questions.filter((q) => q.result === 'Correct').length;
  const totalSeconds = getSelectedTotalSeconds();
  const paceSeconds = n ? totalSeconds / n : 0;

  el.correctStat.textContent = n ? `${correct} / ${n}` : '—';
  el.questionStat.textContent = n || '—';
  el.totalTimeStat.textContent = n ? formatTotalTime(totalSeconds) : '—';
  el.paceStat.textContent = n ? formatTime(paceSeconds) : '—';

  const autoOption = el.timingMode.querySelector('option[value="auto"]');
  autoOption.textContent = state.detectedTotalSeconds
    ? `Auto-detect — ${formatTotalTime(state.detectedTotalSeconds)}`
    : 'Auto-detect — default 45:00';
}

function refreshFilterUi() {
  const mode = document.querySelector('input[name="filterMode"]:checked')?.value || 'all';
  el.selectedFilters.classList.toggle('is-disabled', mode !== 'selected');
}

function getFilteredQuestions() {
  const mode = document.querySelector('input[name="filterMode"]:checked')?.value || 'all';
  if (mode === 'all') return [...state.questions];

  const cutoff = parseTimeToSeconds(el.cutoffTime.value);
  return state.questions.filter((q) => {
    const missed = el.includeIncorrect.checked && q.result === 'Incorrect';
    const slowCorrect = el.includeSlowCorrect.checked
      && q.result === 'Correct'
      && cutoff !== null
      && q.seconds >= cutoff;
    return missed || slowCorrect;
  });
}

function refreshOutput() {
  const selected = getFilteredQuestions();
  el.idOutput.value = selected.map((q) => q.id).join(', ');
  el.selectionCount.textContent = `${selected.length} problem${selected.length === 1 ? '' : 's'}`;
}

const chartMarksPlugin = {
  id: 'gmatMarks',
  beforeDatasetsDraw(chart) {
    if (!state.questions.length) return;
    const { ctx, chartArea, scales } = chart;
    ctx.save();
    ctx.strokeStyle = '#aab0b6';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    const baseline = scales.y.getPixelForValue(0);
    state.questions.forEach((q, i) => {
      const x = scales.x.getPixelForValue(i + 1);
      const y = scales.y.getPixelForValue(q.seconds / 60);
      ctx.beginPath();
      ctx.moveTo(x, baseline);
      ctx.lineTo(x, Math.min(y + 9, baseline));
      ctx.stroke();
    });
    ctx.restore();
  },
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    [0, 1].forEach((datasetIndex) => {
      const meta = chart.getDatasetMeta(datasetIndex);
      meta.data.forEach((point) => {
        if (point.skip) return;
        ctx.save();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        if (datasetIndex === 0) {
          ctx.beginPath();
          ctx.moveTo(point.x - 4.2, point.y + 0.2);
          ctx.lineTo(point.x - 1.2, point.y + 3.1);
          ctx.lineTo(point.x + 4.8, point.y - 3.5);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.moveTo(point.x - 3.7, point.y - 3.7);
          ctx.lineTo(point.x + 3.7, point.y + 3.7);
          ctx.moveTo(point.x + 3.7, point.y - 3.7);
          ctx.lineTo(point.x - 3.7, point.y + 3.7);
          ctx.stroke();
        }
        ctx.restore();
      });
    });
  },
  afterDraw(chart) {
    if (!state.questions.length) return;
    const { ctx, chartArea, scales } = chart;
    const paceSeconds = getSelectedTotalSeconds() / state.questions.length;
    const y = scales.y.getPixelForValue(paceSeconds / 60);
    ctx.save();
    ctx.fillStyle = '#17191c';
    ctx.font = '12px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('Your', chartArea.right + 12, y - 7);
    ctx.fillText('Average', chartArea.right + 12, y + 7);
    ctx.restore();
  },
};

function refreshChart() {
  if (!state.questions.length) return;
  if (state.chart) state.chart.destroy();

  const n = state.questions.length;
  const totalSeconds = getSelectedTotalSeconds();
  const paceSeconds = totalSeconds / n;
  const maxSeconds = Math.max(paceSeconds, ...state.questions.map((q) => q.seconds));
  const yMaxSeconds = Math.max(180, Math.ceil((maxSeconds + 30) / 30) * 30);

  const correctData = state.questions
    .filter((q) => q.result === 'Correct')
    .map((q) => ({ x: q.number, y: q.seconds / 60, id: q.id, result: q.result, seconds: q.seconds }));
  const incorrectData = state.questions
    .filter((q) => q.result === 'Incorrect')
    .map((q) => ({ x: q.number, y: q.seconds / 60, id: q.id, result: q.result, seconds: q.seconds }));

  state.chart = new Chart(el.chartCanvas, {
    type: 'scatter',
    plugins: [chartMarksPlugin],
    data: {
      datasets: [
        {
          label: 'Correctly Answered',
          data: correctData,
          backgroundColor: '#63c900',
          borderColor: '#63c900',
          pointRadius: 10,
          pointHoverRadius: 11,
          pointBorderWidth: 0,
          order: 1,
        },
        {
          label: 'Incorrectly Answered',
          data: incorrectData,
          backgroundColor: '#d94d5c',
          borderColor: '#d94d5c',
          pointRadius: 10,
          pointHoverRadius: 11,
          pointBorderWidth: 0,
          order: 1,
        },
        {
          type: 'line',
          label: 'Your Average',
          data: [{ x: 1, y: paceSeconds / 60 }, { x: n, y: paceSeconds / 60 }],
          borderColor: '#17191c',
          borderWidth: 2,
          borderDash: [2, 2],
          pointRadius: 0,
          pointHitRadius: 0,
          tension: 0,
          order: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      layout: { padding: { top: 12, right: 86, bottom: 2, left: 2 } },
      interaction: { mode: 'nearest', intersect: true },
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: (item) => item.datasetIndex < 2,
          callbacks: {
            title: (items) => items.length ? `Question ${items[0].raw.x}` : '',
            label: (context) => {
              const p = context.raw;
              return [`${p.id}`, `${p.result} • ${formatTime(p.seconds)}`];
            },
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          min: 1,
          max: n,
          offset: true,
          title: { display: true, text: 'Question Number', color: '#17191c', font: { size: 16, weight: '500' }, padding: { top: 12 } },
          ticks: {
            stepSize: 1,
            precision: 0,
            color: '#17191c',
            font: { size: n > 25 ? 9 : 11 },
            callback: (value) => Number.isInteger(value) ? value : '',
          },
          grid: { display: false },
          border: { display: false },
        },
        y: {
          min: 0,
          max: yMaxSeconds / 60,
          title: { display: true, text: 'Response Time', color: '#17191c', font: { size: 16, weight: '500' }, padding: { bottom: 10 } },
          ticks: {
            stepSize: 0.5,
            color: '#17191c',
            font: { size: 11 },
            callback: (value) => formatTime(value * 60),
          },
          grid: { color: '#c9cdd1', lineWidth: 1 },
          border: { display: false },
        },
      },
    },
  });
}

function refreshEverything() {
  state.questions.forEach((q, index) => { q.number = index + 1; });
  refreshStats();
  refreshFilterUi();
  refreshOutput();
  refreshChart();
}

async function copyIds() {
  const text = el.idOutput.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    el.idOutput.focus();
    el.idOutput.select();
    document.execCommand('copy');
  }
  const original = el.copyBtn.textContent;
  el.copyBtn.textContent = 'Copied!';
  setTimeout(() => { el.copyBtn.textContent = original; }, 1000);
}

function saveChart() {
  if (!state.chart) return;
  const link = document.createElement('a');
  link.download = 'gmat-pacing.png';
  link.href = state.chart.toBase64Image('image/png', 1);
  link.click();
}

el.pdfFile.addEventListener('change', () => {
  const file = el.pdfFile.files?.[0];
  el.fileName.textContent = file ? file.name : 'No file selected';
  el.analyzeBtn.disabled = !file;
});

el.analyzeBtn.addEventListener('click', analyzePdf);
el.timingMode.addEventListener('change', refreshEverything);
el.copyBtn.addEventListener('click', copyIds);
el.saveChartBtn.addEventListener('click', saveChart);

document.querySelectorAll('input[name="filterMode"]').forEach((radio) => {
  radio.addEventListener('change', () => { refreshFilterUi(); refreshOutput(); });
});

[el.includeIncorrect, el.includeSlowCorrect].forEach((input) => input.addEventListener('change', refreshOutput));
el.cutoffTime.addEventListener('input', refreshOutput);
el.cutoffTime.addEventListener('change', () => {
  const parsed = parseTimeToSeconds(el.cutoffTime.value);
  if (parsed === null) {
    el.cutoffTime.setCustomValidity('Use m:ss, for example 2:30.');
    el.cutoffTime.reportValidity();
    el.cutoffTime.setCustomValidity('');
    el.cutoffTime.value = '2:30';
  } else {
    el.cutoffTime.value = formatTime(parsed);
  }
  refreshOutput();
});
