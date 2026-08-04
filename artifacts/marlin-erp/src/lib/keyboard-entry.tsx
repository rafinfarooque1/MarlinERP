/**
 * Keyboard Entry Mode — shared machinery for Tally-style mouse-free data entry.
 *
 * Every entry form wires the same three pieces:
 *
 *   1. `onOpenAutoFocus={autoFocusFirst}` on the DialogContent, so the cursor
 *      lands on the first editable field the moment the form opens.
 *   2. `data-kbd-scope` + `onKeyDown={entryScopeKeyDown({...})}` on the form's
 *      wrapping element, which provides:
 *        Enter        → next field (on text/number/date inputs only — buttons,
 *                       comboboxes and textareas keep their native behaviour)
 *        Enter on [data-last-field="1"] → onAddLine (new line, Tally-style)
 *        Ctrl/Cmd+S   → onSave
 *        Ctrl/Cmd+P   → onSaveAndPrint (only when the form supports print)
 *        Ctrl/Cmd+Enter → onComplete (falls back to onSave)
 *        F4           → onAddLine
 *        Delete       → onDeleteLine(rowIndex) when focus is inside a
 *                       [data-kbd-row] and NOT in a text field (Ctrl+Delete
 *                       works everywhere) — plain Delete inside an input keeps
 *                       deleting characters.
 *   3. `advanceOnSelect` on AccountCombobox / SearchableItemSelect, so picking
 *      an option moves focus to the next field instead of back to the trigger.
 *
 * Conventions:
 *   - mouse-only controls (row X buttons, icon buttons) get tabIndex={-1} so the
 *     Enter-walk never lands on them;
 *   - [data-kbd-ignore] subtrees are skipped entirely;
 *   - [data-kbd-first] marks the intended first field when it isn't simply the
 *     first focusable in DOM order;
 *   - [data-field="name"] enables focusField() so validation errors can put the
 *     cursor on the offending field.
 *
 * This file contains NO business logic — it only moves focus and routes keys.
 */

import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = 'input, textarea, select, button, [role="combobox"]';

const isVisible = (el: HTMLElement) =>
  el.offsetParent !== null || el === document.activeElement;

/** All keyboard-reachable fields inside a scope, in DOM order. */
export function getFocusables(scope: HTMLElement): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(el =>
    !el.hasAttribute('disabled') &&
    el.tabIndex >= 0 &&
    !(el instanceof HTMLInputElement && el.type === 'hidden') &&
    !el.closest('[data-kbd-ignore]') &&
    isVisible(el),
  );
}

/** Focus (and text-select) the field after/before `current` inside `scope`. */
export function focusNextField(scope: HTMLElement, current: HTMLElement, dir: 1 | -1 = 1): boolean {
  const els = getFocusables(scope);
  const idx = els.indexOf(current);
  if (idx === -1) return false;
  const next = els[idx + dir];
  if (!next) return false;
  next.focus();
  if (next instanceof HTMLInputElement && /^(text|number|search|tel|email|url)$/.test(next.type)) {
    next.select();
  }
  return true;
}

/**
 * Move focus to the field after `el`, looking the enclosing [data-kbd-scope] up
 * from the element itself. Deferred one tick so it can run from inside Radix
 * close/dismiss handlers (per the Radix focus-return timing).
 */
export function advanceFrom(el: HTMLElement | null | undefined) {
  if (!el) return;
  const scope = el.closest<HTMLElement>('[data-kbd-scope]');
  if (!scope) return;
  window.setTimeout(() => focusNextField(scope, el, 1), 0);
}

/** Focus a combobox trigger and open its popover (Popover opens on click). */
export function focusAndOpen(el: HTMLElement | null | undefined) {
  if (!el) return;
  el.focus();
  el.click();
}

/**
 * Handler for DialogContent's onOpenAutoFocus: put the cursor on the first
 * editable field ([data-kbd-first] wins, otherwise first input/combobox in DOM
 * order) instead of Radix's default first-tabbable (often a button).
 */
export function autoFocusFirst(e: Event) {
  const content = (e.target ?? e.currentTarget) as HTMLElement | null;
  e.preventDefault();
  window.setTimeout(() => {
    if (!content || !content.isConnected) return;
    const explicit = content.querySelector<HTMLElement>('[data-kbd-first]');
    const el = explicit ?? getFocusables(content).find(x =>
      x instanceof HTMLInputElement ||
      x instanceof HTMLTextAreaElement ||
      x instanceof HTMLSelectElement ||
      x.getAttribute('role') === 'combobox',
    );
    if (!el) return;
    el.focus();
    if (el instanceof HTMLInputElement && /^(text|number|search)$/.test(el.type)) el.select();
  }, 0);
}

/** Focus the element carrying [data-field="name"] — for validation errors. */
export function focusField(name: string, scope?: HTMLElement | null) {
  window.setTimeout(() => {
    const root: ParentNode = scope ?? document;
    root.querySelector<HTMLElement>(`[data-field="${name}"]`)?.focus();
  }, 0);
}

export interface EntryScopeHandlers {
  /** Ctrl/Cmd+S. Guard isPending inside the handler. */
  onSave?: () => void;
  /** Ctrl/Cmd+P — only wire on forms that actually have a print/PDF action. */
  onSaveAndPrint?: () => void;
  /** Ctrl/Cmd+Enter — "Complete Sale"-style primary action; falls back to onSave. */
  onComplete?: () => void;
  /** F4, and Enter on the row's [data-last-field="1"] field. */
  onAddLine?: () => void;
  /** Delete/Ctrl+Delete inside a [data-kbd-row="i"] row. Receives the row index. */
  onDeleteLine?: (rowIndex: number) => void;
}

/**
 * Document-level shortcuts (Ctrl+S / Ctrl+P / Ctrl+Enter / F4) for as long as
 * an entry form is open. The scope-level handler only sees keys while focus is
 * inside the scope — this hook catches the shortcuts when focus has wandered
 * (dialog close button, body after a toast) so Ctrl+S never falls through to
 * the browser's own save dialog. `active` should be the dialog's open state
 * (or `true` for always-mounted inline forms).
 */
export function useEntryShortcuts(
  active: boolean,
  handlers: Pick<EntryScopeHandlers, 'onSave' | 'onSaveAndPrint' | 'onComplete' | 'onAddLine'>,
) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return; // the scope handler already took it
      const h = ref.current;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        h.onSave?.();
      } else if (mod && (e.key === 'p' || e.key === 'P') && h.onSaveAndPrint) {
        e.preventDefault();
        h.onSaveAndPrint();
      } else if (mod && e.key === 'Enter') {
        e.preventDefault();
        (h.onComplete ?? h.onSave)?.();
      } else if (e.key === 'F4' && h.onAddLine) {
        e.preventDefault();
        h.onAddLine();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active]);
}

/**
 * Build the onKeyDown handler for an entry scope. Attach to the same element
 * that carries `data-kbd-scope`.
 */
export function entryScopeKeyDown(h: EntryScopeHandlers) {
  return (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.defaultPrevented) return; // cmdk / Radix already consumed it
    const target = e.target as HTMLElement;
    const scope = e.currentTarget as HTMLElement;
    const mod = e.ctrlKey || e.metaKey;

    if (mod && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      h.onSave?.();
      return;
    }
    if (mod && (e.key === 'p' || e.key === 'P') && h.onSaveAndPrint) {
      e.preventDefault();
      h.onSaveAndPrint();
      return;
    }
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      (h.onComplete ?? h.onSave)?.();
      return;
    }
    if (e.key === 'F4' && h.onAddLine) {
      e.preventDefault();
      h.onAddLine();
      return;
    }
    if (e.key === 'Delete' && h.onDeleteLine) {
      const inTextField =
        target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
      if (!inTextField || e.ctrlKey) {
        const row = target.closest<HTMLElement>('[data-kbd-row]');
        if (row) {
          e.preventDefault();
          h.onDeleteLine(Number(row.getAttribute('data-kbd-row')));
        }
      }
      return;
    }
    if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey) {
      // Enter acts as Tab on plain inputs only. Buttons/combobox triggers keep
      // their native Enter (open/activate); textareas keep the newline.
      if (target instanceof HTMLInputElement && !target.closest('[data-kbd-ignore]')) {
        e.preventDefault();
        if (target.getAttribute('data-last-field') === '1' && h.onAddLine) {
          h.onAddLine();
          return;
        }
        focusNextField(scope, target, 1);
      }
    }
  };
}
