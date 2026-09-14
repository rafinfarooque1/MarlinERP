---
name: Payment modes and invoice sharing
description: The canonical counter payment modes, how legacy values are handled, and the seam that keeps invoice-share message composition separate from the PDF renderer.
---

## Rule: the counter has four modes — Cash, Bank, UPI, Credit

'bank' covers every payment landing in a company bank account (card swipe, netbanking, NEFT/IMPS).
UPI stays separate only because operators reconcile it against the UPI ID printed on the invoice.
Credit is the only mode that creates a receivable and the only one under credit-limit control;
everything else is settled the moment the sale is recorded.

**Why:** "Card" as a top-level mode described the instrument, not where the money went, and left
netbanking/transfer sales with no honest option at the counter.

**How to apply:** one canonical list per side (api-server and web each own a `paymentModes` module)
and both must agree. Never re-derive the settled/clears-through-bank distinction inline with an
array literal — that is exactly what drifted before.

## Rule: legacy stored modes are displayed, never rewritten

Existing rows hold 'card' and 'bank_transfer'. They mean what 'bank' means, so they are accepted on
read and edit and rendered as "Bank"; the stored value stays put.

**Why:** reconciliation records already reference the stored value, and rewriting history would
break the audit trail for a cosmetic rename.

**How to apply:** map on display (label helper) and on edit (collapse to 'bank' for the form).
Any *filter* that offers "Bank" must match the legacy values too, or old rows vanish from the list.

## Rule: sale edits may reassign the complete current mode set

The edit form offers Cash, Bank, UPI, and Credit. The API accepts those canonical modes on edit,
while still preserving a stored 'card' or 'bank_transfer' value when the selected mode remains Bank.

**Why:** operators need to correct the settlement mode on an existing invoice, not only retain the
mode it already had; the historical spellings still cannot be rewritten because reconciliation rows
reference them.

**How to apply:** keep new-sale creation rules separate from edit rules. When an edit changes a
settled mode, rebuild its counter history row and accounting receipt inside the edit transaction;
when it changes to Credit, remove billing-time settlement rows and re-derive the paid amount.

## Rule: message composition and delivery channel live outside the invoice renderer

There is exactly ONE invoice PDF renderer, reached through a signed public link. What to *say* when
sharing that link, and *how* it travels, are separate: a share module owns phone normalisation,
message text and a channel interface. The wa.me deep link is today's only channel.

**Why:** a WhatsApp Business API path attaches the PDF instead of linking it. With the seam in
place that is a new channel implementation; without it, it becomes an edit to the renderer and the
sales page.

**How to apply:** new share channels implement the channel interface and register ahead of wa.me.
Channels that send server-side return no URL; link channels return a URL the caller must navigate
to **inside the original click gesture** — opening the tab late loses the gesture and popup
blockers swallow it silently.
