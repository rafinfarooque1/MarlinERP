---
name: Autoscale rejects non-chunked responses over 32 MB
description: Why a large download with an explicit Content-Length works in dev but returns an instant empty HTTP 500 only on the published (autoscale/Cloud Run) domain, and the streaming rule that fixes it.
---

# Explicit Content-Length > 32 MB = empty 500 in production only

**The rule:** any endpoint that can serve a response body larger than 32 MB
must NOT set an explicit `Content-Length`. Let Node stream it
(`Transfer-Encoding: chunked`); the platform allows streamed responses of any
size.

**Why:** the published app runs on autoscale (Cloud Run behind Google Front
End). GFE rejects non-chunked responses larger than 32 MB and synthesizes its
own reply **before any byte leaves the app**: instant `HTTP 500`,
`content-length: 0`, `content-type: text/html`, `server: Google Frontend`,
and NONE of the app's headers. The dev workspace proxy has no such limit, so
the same code passes every dev test. This is exactly how the ~94 MB APK
download (`/public/app/apk`) broke: dev fine, prod instant empty 500.

**How to recognize it:** a prod-only 5xx whose response carries zero app-set
headers (e.g. a `Cache-Control` the handler sets unconditionally is missing)
did not come from the handler — suspect the front-end. If it arrives in under
a second on a large download, it is this limit.

**How to apply:**
- Drop `Content-Length` on any potentially-large response; keep
  Content-Type/Content-Disposition and any pre-stream integrity checks
  (verify object metadata size against the manifest BEFORE streaming).
- Trade-off: browsers can't show download % or resume; expose size via a
  side-channel (info endpoint) if the UI needs it.
- Backup downloads were FIXED (Aug 2026): Content-Length dropped, chunked
  streaming verified in dev. Known remaining offender: the generic
  `/storage/objects/*` path (`downloadObject()` in lib/objectStorage.ts adds
  Content-Length from object metadata). PDF buffers are sub-MB and fine.
- Second prod-only risk on big downloads: the platform request timeout is
  wall-clock for the client connection — a very slow mobile link pulling
  ~94 MB can still be cut off even when chunked.
