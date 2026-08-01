---
name: Dual toast systems — one renders nowhere
description: Two notification stacks coexist; only one renderer is mounted, so the other's calls silently show nothing.
---

# Dual toast systems — one renders nowhere

The web app contains two toast stacks but mounts only sonner's renderer. Calls through the legacy hook succeed silently and display nothing — no crash, no console error. Login errors (including lockout messages) were invisible for a long time because of this.

**Why it matters:** an unmounted notification renderer is undetectable by unit tests or code reading; only an e2e assertion that the message actually appears catches it.

**How to apply:** route notifications through sonner. When a "missing toast" is reported, first check which renderer the app mounts before debugging the caller. A follow-up task exists to delete the dead stack.
