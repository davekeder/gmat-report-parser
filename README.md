# GMAT Practice Report Parser

## v1.1.1 OCR hotfix

- Restores the primary summary OCR pass to the same settings used by v1.0.
- Adds a fallback summary OCR pass only when the first pass misses question rows.
- Keeps the high-resolution Question-column cross-check from v1.1.
- Applies narrow `PS` numeric cleanup to the targeted pass without restricting other Question ID formats.


A browser-based utility for GMAT timed-practice result PDFs.

## What it does

- Reads page 1 of a GMAT timed-practice results PDF in the browser.
- Uses a full summary-table OCR pass to extract question number, Question ID, result, and time.
- Uses a second enlarged OCR pass on only the **Question** column to cross-check IDs.
- Does **not** restrict IDs to PS + digits; letters and punctuation such as dashes are allowed.
- Highlights any Question ID where the two OCR passes disagree and lets you switch between the two readings.
- Supports variable report lengths (for example 20, 21, or 23 questions).
- Supports 45:00 standard time, 67:30 time-and-a-half, and 90:00 double time.
- Creates an mba.com-style pacing graph.
- Outputs all IDs, incorrect IDs, and/or correct IDs with time greater than or equal to a chosen cutoff.
- Lets extracted Question IDs, results, and times be edited before copying.
- Saves the pacing graph as a PNG.

## Privacy

The selected PDF is processed locally in the browser. This project does not include an application server or upload endpoint. PDF.js, Tesseract.js, and Chart.js are loaded from public CDNs.

## Run locally

Because the app uses JavaScript modules, serve the folder over a local HTTP server instead of double-clicking `index.html`.

From the project directory:

```powershell
py -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

## Publish with GitHub Pages

1. Push the files to a GitHub repository.
2. Open **Settings → Pages**.
3. Choose **Deploy from a branch**.
4. Select `main` and `/ (root)`.
5. Save.

No build step is required.
