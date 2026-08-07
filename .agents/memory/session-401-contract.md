---
name: 401 = dead session contract
description: Both clients log the user out on any confirmed 401 — servers must never return 401 for a wrong form field
---

**Rule:** a 401 response means "your token is rejected" and both clients (web sessionContext event + mobile unauthorized handler in the shared custom-fetch) clear the session on it. Any endpoint validating a *typed credential field* while the token is valid must return 400 — e.g. change-password's wrong-current-password. custom-fetch additionally suppresses the handler for `/auth/login` so a bad login attempt can't erase a still-valid persisted session.

**Why:** change-password returned 401 for a wrong current password; the mobile app's expired-session handler logged the user out mid-modal. The web app had the same latent bug. Found only by e2e testing.

**How to apply:** when adding any endpoint that checks a password/PIN/OTP from the request body, return 400 on mismatch. When adding session-cleanup logic client-side, key it off the shared unauthorized handler, never raw status checks.

Related: employees may always read their OWN rows on self-service endpoints (advances GET self-scopes callers lacking the page right instead of 403ing) — page rights gate the wider view, not self-service; a 403 there silently zeroes mobile Home tiles.
