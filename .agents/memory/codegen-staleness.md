---
name: Codegen staleness trap (api-zod / api-client-react)
description: Regenerating clients from openapi.yaml can flip validators stricter than what UI forms actually send
---

# Codegen staleness trap

The committed generated code (`lib/api-zod`, `lib/api-client-react`) can be **stale relative to `lib/api-spec/openapi.yaml`**. Running codegen for an unrelated spec change regenerates EVERYTHING, silently picking up old spec requirements the previous generated code never enforced.

**Why:** The spec always declared `paymentMode` required on SaleInput, but the committed zod had it `.optional()`. A codegen run for new credit fields flipped it to required — and the Sales form never sent `paymentMode`, so every UI sale creation started failing with a 400 zod error. The API tests passed (they sent the field); only browser E2E caught it.

**How to apply:** After any codegen run, `git diff` the generated packages for fields that changed from `.optional()` to required (or newly-added required fields), then verify the UI forms/payloads that hit those endpoints actually send them. Browser-level E2E after codegen is the reliable net — request-level tests mask client payload gaps.
