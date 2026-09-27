---
name: Patch application checks
description: Partial application behavior when a multi-hunk patch reports failure
---

**Rule:** A multi-hunk patch that reports failure may still have applied earlier hunks. Inspect the working tree and every targeted file before retrying the full patch.

**Why:** A failed multi-hunk edit left some changes in place, and retrying without checking would have introduced duplicate code.

**How to apply:** Keep patches focused. After a reported failure, inspect `git diff` and search the target files before deciding which hunks need another attempt.