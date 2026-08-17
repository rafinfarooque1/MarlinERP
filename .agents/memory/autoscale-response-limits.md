---
name: Autoscale rejects non-chunked responses over 32 MB
description: Why a large download with an explicit Content-Length works in dev but returns an instant empty HTTP 500 only on the published (autoscale/Cloud Run) domain, and the streaming rule that fixes it.
---

# Explicit Content-Length > 32 MB = empty 500 in production only

**Requests have the same 32 MB cap:** the front-end answers an inbound body
over 32 MB with its own bare HTML `413 Request Entity Too Large` ("Your client
issued a request that was too large") before the app sees a byte — app-level
limits and friendly errors never run. Large uploads must bypass the app server
entirely: presigned PUT straight to object storage, then a finalize endpoint
where the server pulls and validates the object. Rules for that flow: the
client holds only an opaque uuid and the server reconstructs the object name
(no request may name a bucket path); the sidecar signer cannot bind a size to
the URL, so enforce the limit on object METADATA before downloading; serialize
finalize on an advisory lock keyed by the uuid; sweep abandoned staging
objects from both ends of the flow, never only at finalize.

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
