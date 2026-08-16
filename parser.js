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

function normalizeOcrPunctuation(value) {
  return String(value || '')
    .replace(/[—–−]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function normalizeQuestionId(value) {
  return normalizeOcrPunctuation(value)
    .replace(/^[-|:;,.\s]+/, '')
    .replace(/[-|:;,.\s]+$/, '')
    .toUpperCase();
}

function repairCommonPsNumericId(value) {
  const id = normalizeQuestionId(value);
  // Narrow repair for the familiar PS + numeric format seen in these reports.
  // Other formats (including IDs with dashes or additional letters) are never
  // altered. The targeted cross-check pass intentionally stays raw so a
  // disagreement remains visible to the user.
  if (!/^PS[0-9OILS]{4,8}$/.test(id)) return id;
  return `PS${id.slice(2)
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/S/g, '5')}`;
}

function extractStructuredQuestionId(line) {
  // The summary table is laid out as:
  // # | Question | Difficulty | Result | Your answer | Correct | Time
  // Capturing everything between the row number and Difficulty supports IDs
  // containing letters, digits, dashes, underscores, periods, and other text.
  const match = line.match(/^\s*\d{1,3}\s+(.+?)\s+(easy|medium|hard)\s+(?:Incorrect|Correct)\b/i);
  if (!match) return null;
  return repairCommonPsNumericId(match[1]);
}

function extractQuestionIdFallback(line) {
  // Fallback for OCR where the table spacing is damaged. Prefer a token after
  // an initial row number, but do not impose a PS/digits-only format.
  const rowToken = line.match(/^\s*\d{1,3}\s+([^\s]+)(?:\s+|$)/);
  if (rowToken) return repairCommonPsNumericId(rowToken[1]);

  // Legacy-style fallback for common GMAT IDs embedded in a line.
  const common = line.match(/\b(PS[0-9OILS]{4,8})\b/i);
  return common ? repairCommonPsNumericId(common[1]) : null;
}

function extractQuestionId(line) {
  return extractStructuredQuestionId(line) || extractQuestionIdFallback(line);
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
  return normalizeOcrPunctuation(text)
    .replace(/\r/g, '')
    .trim();
}

export function parseQuestionColumnText(rawText) {
  const text = cleanOcrText(rawText || '');
  const candidates = text
    .split('\n')
    .map((line) => normalizeOcrPunctuation(line))
    .filter(Boolean)
    .map((line) => line.replace(/^\s*\d{1,3}\s+/, '').trim())
    .map((line) => line.replace(/\s+(easy|medium|hard)\s*$/i, '').trim())
    .filter((line) => !/^#?\s*question\s*$/i.test(line))
    .filter((line) => !/^(difficulty|result|your answer|correct|time)$/i.test(line))
    .filter((line) => /[A-Za-z0-9]/.test(line))
    // Apply only the narrow PS+numeric OCR cleanup here. Generic IDs with
    // letters, dashes, underscores, punctuation, etc. are left untouched.
    .map(repairCommonPsNumericId)
    .filter(Boolean);

  return { text, ids: candidates };
}

export function reconcileQuestionIds(questions, secondaryIds) {
  const warnings = [];
  let disagreements = 0;

  questions.forEach((question) => {
    question.ocrCheck = {
      status: 'single',
      primaryId: question.id,
      secondaryId: null,
      alternateId: null,
      selectedSource: 'full',
    };
  });

  if (!secondaryIds?.length) {
    warnings.push('The targeted Question-column OCR pass did not return any IDs.');
    return { questions, disagreements, warnings };
  }

  if (secondaryIds.length !== questions.length) {
    warnings.push(`The targeted Question-column OCR pass found ${secondaryIds.length} IDs instead of ${questions.length}, so IDs were not auto-reconciled.`);
    return { questions, disagreements, warnings };
  }

  questions.forEach((question, index) => {
    const primaryId = normalizeQuestionId(question.id);
    const secondaryId = normalizeQuestionId(secondaryIds[index]);

    if (primaryId === secondaryId) {
      question.id = primaryId;
      question.ocrCheck = {
        status: 'match',
        primaryId,
        secondaryId,
        alternateId: null,
        selectedSource: 'targeted',
      };
      return;
    }

    disagreements += 1;

    // Any disagreement is surfaced for review. The targeted pass uses a
    // tightly cropped, enlarged Question column, so it is the default choice
    // whenever the two OCR reads conflict. The full-page read remains
    // available as a one-click alternate in the verification table.
    question.id = secondaryId;
    question.ocrCheck = {
      status: 'review',
      primaryId,
      secondaryId,
      alternateId: primaryId,
      selectedSource: 'targeted',
    };
  });

  return { questions, disagreements, warnings };
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
