---
name: Patch application checks
description: Partial application behavior when a multi-hunk patch reports failure
---

**Rule:** Order multi-hunk patches from earlier to later in each file. If a patch reports failure, it may still have applied earlier hunks, so inspect the working tree and every targeted file before retrying.

**Why:** A failed multi-hunk edit can leave partial changes, while out-of-order hunks can prevent a patch from matching; retrying blindly risks duplicate code or another failure.

**How to apply:** Keep patches focused and hunks source-ordered. After a reported failure, inspect `git diff` and search the target files before deciding which hunks need another attempt.