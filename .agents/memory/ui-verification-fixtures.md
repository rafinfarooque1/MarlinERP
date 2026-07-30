---
name: Verifying interactive UI needs an adequate fixture
description: Why browser-test "failures" on list/dropdown components are usually fixture artifacts, and how to get a decisive answer instead of another round.
---

# Verifying interactive UI needs an adequate fixture

A browser test can only observe behaviour the fixture makes reachable. When a UI test
reports that an interaction "doesn't work", rule out the fixture before touching the code.

**Why:** on this project a searchable dropdown was reported broken four times across three
test rounds. Every report but one was an artifact:

- *Arrow keys don't move the highlight* — the dev database held exactly ONE item, so there
  was no second row to move to.
- *The list doesn't scroll (`scrollTop` stuck at 0)* — the isolated harness rendered a
  component that lives in a different workspace package, and the sandbox's Tailwind only
  scans its own `src`. The `max-h-[...]` class was never generated, so the list had no
  height limit and genuinely had nothing to scroll. The same gap silently dropped every
  `sm:` responsive variant, so the desktop layout and column header "disappeared" too.
- *Escape doesn't close / focus is trapped* — the automation had focus parked on the trigger
  button, outside the popover, before sending the key.

**How to apply:**

1. Before believing a negative result, ask what the fixture actually contained. Count the
   rows. A one-row list cannot demonstrate navigation, scrolling, or paging.
2. Rendering a component outside its home package means its utility classes are not
   compiled. Point the sandbox's CSS scanner at the component's real path, or accept that
   layout and responsive behaviour are unverifiable there and prove them in the real app.
   Confirm the fix landed by grepping the *served* stylesheet for a distinctive class.
3. To separate "component is broken" from "the harness never delivered the input", dispatch
   the event directly in the page and compare against the automation's own keypress:
   `el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`.
   If the synthetic path works and the real one doesn't, the component is fine — check
   `document.activeElement` and you will usually find focus somewhere unexpected.
4. Prefer reading the library source over speculating about it. Checking whether `cmdk`
   forwards a user `onKeyDown` (it does, before its own) and whether the shadcn wrapper
   spreads props took one grep and outranked three rounds of black-box testing.
5. Static facts do not need a browser at all. Attribute presence, truncation classes, and
   similar questions are answered faster and more reliably by grepping the component.
