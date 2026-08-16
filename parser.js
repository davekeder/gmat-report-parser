export function parseTimeToSeconds(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{1,3})\s*:\s*(\d{2})$/);
  if (!match) return null;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  if (!Number.isFinite(minutes) || seconds < 0 || seconds > 59) return null;
  return minutes * 60 + seconds;
}

export function formatTime(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '—';
  const rounded = Math.round(totalSeconds);
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function normalizeQuestionId(prefix, numericPart) {
  const cleanPrefix = prefix.toUpperCase();
  const cleanDigits = numericPart
    .replace(/[Oo]/g, '0')
    .replace(/[IlL]/g, '1')
    .replace(/[Ss]/g, '5');
  return `${cleanPrefix}${cleanDigits}`;
}

function extractQuestionId(line) {
  // GMAT practice IDs are commonly short letter prefixes followed by digits.
  // OCR frequently reads 0/O and 1/I interchangeably. A leading numeric 0 can
  // therefore be swallowed into the letter prefix (for example PS06959 -> PSO6959).
  const match = line.match(/\b([A-Za-z]{2,5})\s*([0-9OoIlLSs]{4,8})\b/);
  if (!match) return null;

  const raw = `${match[1]}${match[2]}`;
  for (let split = 2; split <= 5; split += 1) {
    const prefix = raw.slice(0, split);
    const suffix = raw.slice(split);
    if (/^[A-Za-z]+$/.test(prefix) && suffix.length >= 4 && /^[0-9OoIlLSs]+$/.test(suffix)) {
      return normalizeQuestionId(prefix, suffix);
    }
  }
  return normalizeQuestionId(match[1], match[2]);
}

function extractResult(line) {
  if (/\bIncorrect\b/i.test(line)) return 'Incorrect';
  if (/\bCorrect\b/i.test(line)) return 'Correct';
  return null;
}

function lastTimeOnLine(line) {
  const matches = [...line.matchAll(/\b(\d{1,3})\s*:\s*(\d{2})\b/g)];
  if (!matches.length) return null;
  return parseTimeToSeconds(`${matches.at(-1)[1]}:${matches.at(-1)[2]}`);
}

function cleanOcrText(text) {
  return text
    .replace(/[—–]/g, '-')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\r/g, '')
    .trim();
}

export function parseReportText(rawText) {
  const text = cleanOcrText(rawText || '');
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);

  const totalMatch = text.match(/Total\s*time\s*[:\-]?\s*(\d{1,3})\s*:\s*(\d{2})/i);
  const detectedTotalSeconds = totalMatch
    ? parseTimeToSeconds(`${totalMatch[1]}:${totalMatch[2]}`)
    : null;

  const scoreMatch = text.match(/Score\s*[:\-]?\s*(\d+)\s*\/\s*(\d+)/i);
  const detectedScore = scoreMatch
    ? { correct: Number(scoreMatch[1]), total: Number(scoreMatch[2]) }
    : null;

  const questions = [];

  for (const line of lines) {
    if (/Difficulty\s+Result/i.test(line)) continue;
    const id = extractQuestionId(line);
    const result = extractResult(line);
    const seconds = lastTimeOnLine(line);
    if (id && result && Number.isFinite(seconds)) {
      questions.push({ number: questions.length + 1, id, result, seconds });
    }
  }

  // Fallback for OCR engines that split table cells into separate lines.
  if (questions.length < 2) {
    const bodyLines = lines.filter((line) => !/Total\s*time/i.test(line) && !/Difficulty\s+Result/i.test(line));
    const ids = bodyLines.map(extractQuestionId).filter(Boolean);
    const results = bodyLines.map(extractResult).filter(Boolean);
    const times = bodyLines.map(lastTimeOnLine).filter(Number.isFinite);
    const n = Math.min(ids.length, results.length, times.length);
    questions.length = 0;
    for (let i = 0; i < n; i += 1) {
      questions.push({ number: i + 1, id: ids[i], result: results[i], seconds: times[i] });
    }
  }

  const warnings = [];
  if (!questions.length) warnings.push('No question rows were detected.');
  if (detectedScore && questions.length && questions.length !== detectedScore.total) {
    warnings.push(`Detected ${questions.length} question rows, but the report score indicates ${detectedScore.total}.`);
  }
  if (detectedScore && questions.length) {
    const correctCount = questions.filter((q) => q.result === 'Correct').length;
    if (correctCount !== detectedScore.correct) {
      warnings.push(`Detected ${correctCount} correct results, but the report score indicates ${detectedScore.correct}.`);
    }
  }

  return { text, questions, detectedTotalSeconds, detectedScore, warnings };
}
