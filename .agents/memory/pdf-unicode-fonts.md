---
name: PDF Unicode fonts (the rupee-sign trap)
description: Why jsPDF prints ₹ as a stray superscript, and the settled font strategy for this project's PDFs.
---

# The symptom

Money on a generated PDF reads `¹6,33,194.00` instead of `₹6,33,194.00`.

# The cause

jsPDF's built-in faces (Helvetica, Times, Courier) are **WinAnsi/Latin-1**. U+20B9
(the Indian rupee sign) does not exist in that encoding, so the glyph is silently
mapped to whatever occupies that byte — a superscript one. Nothing throws. It is
purely an encoding limit, not a rendering or CSS problem, so no amount of font
sizing, escaping or string manipulation fixes it.

**Why:** every workaround people try first (`\u20B9` escapes, `Rs.` prefixes in
some places but not others, HTML entities) either changes nothing or makes the
document inconsistent.

# The rule

A PDF that must print ₹ has to **embed a TrueType face that contains the glyph**.
There is no lighter option.

**How to apply:**
- Vendor the font as base64 in its own module and register it with
  `addFileToVFS` + `addFont` before any text is drawn.
- Put the vendored font behind a **dynamic import** so the bundle only pays for
  it when a PDF is actually generated. Vite emits it as a separate lazy chunk;
  esbuild inlines it into the server bundle, which is fine.
- Do **not** reach for a subsetting library. jsPDF subsets embedded TrueType
  itself — a ~1 MB source face came out as a ~54 KB PDF. Installing `fontkit`
  to pre-subset is wasted work (and pnpm's workspace-root guard blocks a casual
  install anyway).
- Legacy documents left on the built-in face must print `Rs. ` — a mixed
  document set where some files show ₹ and others show `¹` is worse than one
  that is consistently ASCII.

# Related

Indian digit grouping (`6,33,194.00`, not `633,194.00`) is a *separate* problem
from the glyph. `Intl.NumberFormat('en-IN')` handles the grouping; it does not
help with the symbol.
