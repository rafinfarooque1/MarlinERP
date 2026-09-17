---
name: Report parity gates
description: How to verify report screen/API/PDF/XLSX parity when browser DOM capture is unavailable.
---

Use the API response as the screen source only when the browser DOM cannot be captured, then compare its row counts and numeric anchors against values read from generated PDF text and XLSX cells. Treat a missing toolbar export action as a real FAIL even if the renderer endpoint works.

**Why:** A successful file download is not evidence that the file contains the visible report values, and a backend export route cannot prove that the UI exposes the action.

**How to apply:** Run both scopes and date semantics, parse files with `pdftotext` and an XLSX reader, check location/date leakage, and report any UI action gap separately from renderer parity.