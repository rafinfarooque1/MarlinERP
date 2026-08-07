---
name: React Native Web dialogs
description: Alert.alert is a silent no-op on web — confirms and error popups must go through lib/dialogs.ts
---

**Rule:** in the employee app, never call `Alert.alert` directly. Use `confirmDialog()` / `notify()` from `lib/dialogs.ts` (window.confirm / window.alert on web, Alert on native).

**Why:** react-native-web's `Alert.alert` does nothing. Confirm-gated actions (leave cancellation) were un-triggerable on web, and every error message was invisible — it looked like a broken button, not a missing dialog. Found by e2e testing.

**How to apply:** any new destructive confirm or error popup in the mobile app goes through the helper. When a tap "does nothing" in a web test, grep for `Alert.alert` before debugging handlers.
