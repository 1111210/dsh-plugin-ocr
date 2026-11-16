# Read a document: choose text extraction, OCR, or vision

This skill decides how to read a document. Judge the document type roughly
first — from the file name, extension, and a quick look — and only then choose a
path. Do not call `ocr_extract` before this step.

## 1. Parse machine-readable text directly — do not call `ocr_extract`

When the text is already in the file, direct parsing is free, instant, and
lossless, so it always wins:

- Markdown, plain text, CSV/TSV, JSON, YAML, XML, HTML, source code, logs:
  `read` the file, or `grep` it.
- Word, PowerPoint, Excel: the Office tools or a local converter.
- PDF with a text layer: a direct PDF text extractor such as `pdftotext`, a
  Python PDF library, or any available converter.
- E-mail, chat exports, and other structured text formats: read the raw text.

Only when no direct parser is available for a text-layer document may OCR be
used as a fallback, and say so if you do.

If a direct read returns empty pages, garbled glyphs, `(cid:123)` placeholders,
or far less text than the page count implies, the document is probably a scan.
Reclassify it as case 2 and use `ocr_extract`.

## 2. Use `ocr_extract` for text-bearing documents without readable text

Call `ocr_extract` when the document is mainly text but the text is only a
picture:

- scanned or photocopied books, manuscripts, reports, contracts, papers;
- photographed document pages and screenshots of text;
- image-only PDF, DOCX, or PPTX files, and slides exported as images;
- forms, invoices, receipts, statements, tickets, and handwriting that must be
  transcribed as text.

Pass the whole file: recognition is billed per page of the uploaded file and one
call returns every page, so do not pre-split a document just to read it.

## 3. Keep image-led documents on your own vision

When the meaning lives in the picture, use your own visual ability instead of
OCR — `read_image`, a rendered page, or the Office render tool:

- architecture, flow, network, and sequence diagrams;
- charts, plots, dashboards, and infographics;
- UI screenshots where layout and controls matter;
- picture books, comics, illustrated spreads;
- mechanical, engineering, and CAD drawings, blueprints, floor plans;
- maps, photographs of scenes, and any document whose answer depends on
  geometry, arrows, color, or spatial relation.

OCR returns only recognized text. It drops exactly the structure those documents
communicate, so use it on them only to read their captions or labels, together
with your vision.

## 4. Work with the result

- Pages arrive in page order. Cite page numbers when you report content.
- A page whose `finish_reason` is `length` is incomplete. Do not quote it as the
  whole page; mention the truncation, and if the missing content matters, ask the
  user instead of silently reconstructing it.
- Quote recognized text as recognized text. Scans can misread characters, so do
  not silently "fix" numbers, names, or codes that matter.
- A very large result may be stored as a file with a notice naming its path.
  Read or grep that file instead of calling OCR again; a second call re-uploads
  the document and is billed again.
- The tool sends the file to the DeepSeek OCR API and does not save it. Never
  upload a file the user asked to keep off external services.
- Limits: 100 MiB and 1,000 pages per file, 180 seconds per call; an account can
  run 15 recognitions at once. A failure that names one of these limits is not
  worth retrying unchanged.
