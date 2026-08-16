# GMAT Practice Report Parser

A small client-side web app for GMAT timed-practice score reports.

## Features

- Reads the summary page of a GMAT timed-practice PDF.
- Extracts the **Question** ID, Correct/Incorrect result, and response time.
- Generates a comma-separated problem ID string for:
  - all problems;
  - incorrect problems;
  - correct problems with response time **greater than or equal to** a user-entered cutoff;
  - or the union of the latter two filters.
- Creates an mba.com-inspired response-time plot with green correct markers, red incorrect markers, and a dotted average-pacing line.
- Supports timing targets of:
  - standard: **45:00**;
  - time-and-a-half: **67:30**;
  - double time: **90:00**;
  - automatic detection from the report.
- Provides an editable verification table to correct occasional OCR errors.
- Can save the pacing chart as a PNG.

## Privacy / architecture

The app is static. The selected PDF is rendered with PDF.js and OCR'd with Tesseract.js inside the browser. There is no application backend and the PDF is not uploaded by this app.

The JavaScript libraries and OCR language assets are loaded from public CDNs, so an internet connection is required when the page is first loaded.

## Run locally

Because PDF.js is loaded as a JavaScript module, serve the directory over a local web server rather than opening `index.html` directly.

From the project folder:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

If `python` is not recognized on Windows, try:

```bash
py -m http.server 8000
```

## GitHub Pages

This project has no build step. Publish the repository's `main` branch from the repository root using **Settings → Pages → Deploy from a branch**.

## Files

- `index.html` — app markup
- `styles.css` — layout and visual design
- `app.js` — PDF rendering, OCR, graph, filtering, editing, and UI logic
- `parser.js` — OCR text parsing and time utilities
