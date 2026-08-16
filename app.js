import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.149/build/pdf.min.mjs';
import { parseReportText, parseTimeToSeconds, formatTime } from './parser.js';

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
};

const state = {
  questions: [],
  detectedTotalSeconds: null,
  detectedScore: null,
  rawText: '',
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

  setProgress(18, 'Rendering summary page…');
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
  // Cropping makes browser OCR both faster and more accurate.
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = pageCanvas.width;
  cropCanvas.height = Math.floor(pageCanvas.height * 0.70);
  const cropCtx = cropCanvas.getContext('2d', { alpha: false });
  cropCtx.fillStyle = '#ffffff';
  cropCtx.fillRect(0, 0, cropCanvas.width, cropCanvas.height);
  cropCtx.drawImage(
    pageCanvas,
    0, 0, cropCanvas.width, cropCanvas.height,
    0, 0, cropCanvas.width, cropCanvas.height,
  );

  return cropCanvas;
}

async function runOcr(canvas) {
  setProgress(26, 'Loading OCR engine…');
  const worker = await Tesseract.createWorker('eng', 1, {
    logger: (message) => {
      if (message.status === 'recognizing text') {
        const pct = 30 + Math.round((message.progress || 0) * 62);
        setProgress(pct, `Reading summary table… ${Math.round((message.progress || 0) * 100)}%`);
      }
    },
  });

  try {
    await worker.setParameters({
      preserve_interword_spaces: '1',
    });
    const result = await worker.recognize(canvas);
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
    const canvas = await renderSummaryPage(file);
    const text = await runOcr(canvas);
    setProgress(95, 'Parsing question data…');

    const parsed = parseReportText(text);
    if (!parsed.questions.length) {
      throw new Error('I could not find question rows on the first page. Open “Show raw OCR text” after a successful parse, or try another GMAT results PDF.');
    }

    state.questions = parsed.questions;
    state.detectedTotalSeconds = parsed.detectedTotalSeconds;
    state.detectedScore = parsed.detectedScore;
    state.rawText = parsed.text;

    el.ocrText.textContent = parsed.text;
    el.timingMode.value = 'auto';
    renderVerificationTable();
    refreshEverything();
    el.resultsArea.hidden = false;

    setProgress(100, 'Done');
    const baseMessage = `Found ${state.questions.length} questions${state.detectedTotalSeconds ? ` and detected ${formatTotalTime(state.detectedTotalSeconds)} total time` : ''}.`;
    if (parsed.warnings.length) {
      showStatus(`${baseMessage} Please verify the table: ${parsed.warnings.join(' ')}`, 'warning');
    } else {
      showStatus(`${baseMessage} OCR checks match the report summary.`, 'success');
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
    row.className = question.result === 'Correct' ? 'row-correct' : 'row-incorrect';
    row.innerHTML = `
      <td>${index + 1}</td>
      <td class="id-cell"><input class="table-input id-editor" value="${escapeHtml(question.id)}" aria-label="Question ${index + 1} ID" /></td>
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
      refreshEverything();
    });

    resultEditor.addEventListener('change', () => {
      question.result = resultEditor.value;
      row.className = question.result === 'Correct' ? 'row-correct' : 'row-incorrect';
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

    el.verificationBody.appendChild(row);
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
