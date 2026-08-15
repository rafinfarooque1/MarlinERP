/**
 * TransactionDialog — the dialog wrapper for entry forms whose typed data
 * must never be lost to an accidental dismissal.
 *
 * The rule (docs/UI_CONVENTIONS.md → "Transaction dialogs"):
 *  - While the form is dirty, clicking OUTSIDE the dialog does nothing —
 *    the accidental path is silently ignored, no popup spam.
 *  - While dirty, the deliberate close paths (Escape, the ✕ button, a
 *    Cancel button wrapped in <DialogClose>) first show a
 *    "Discard unsaved changes?" confirmation; only Discard closes.
 *  - A clean form closes exactly like a plain Dialog.
 *  - Programmatic closes (e.g. `setIsOpen(false)` after a successful save)
 *    bypass the guard by construction — they set the parent state directly.
 *
 * Responsive contract, baked into TransactionDialogContent:
 *  - Phones: near-fullscreen (width/height ≈ viewport minus a small inset).
 *  - Desktop: unchanged — pages keep their `sm:max-w-*`; height capped with
 *    internal vertical scrolling (from the base DialogContent).
 *  - Never scrolls horizontally; long item/ledger names wrap (`break-words`).
 *
 * Usage:
 *   <TransactionDialog open={isOpen} onOpenChange={handleChange} dirty={form.formState.isDirty}>
 *     <TransactionDialogContent className="sm:max-w-3xl">
 *       ...existing dialog body, unchanged...
 *       <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
 *     </TransactionDialogContent>
 *   </TransactionDialog>
 *
 * Dirty convention:
 *  - react-hook-form pages pass `form.formState.isDirty`, OR-ing any prefill
 *    flag that `form.reset(...)` hides (e.g. convert-from-quotation).
 *  - Manual-state forms compute a boolean from their drafts (compare each
 *    field with the value it was initialized from).
 */
import * as React from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

const DirtyContext = React.createContext(false);

interface TransactionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Is there unsaved data the user would lose on close? */
  dirty: boolean;
  children: React.ReactNode;
}

export function TransactionDialog({ open, onOpenChange, dirty, children }: TransactionDialogProps) {
  const [confirming, setConfirming] = React.useState(false);

  // A close that arrives while the dialog is already gone (or a reopen)
  // must never leave a stale confirmation behind.
  React.useEffect(() => {
    if (!open) setConfirming(false);
  }, [open]);

  const handleOpenChange = (next: boolean) => {
    if (!next && dirty) {
      setConfirming(true);
      return; // dialog stays open until the user decides
    }
    onOpenChange(next);
  };

  return (
    <DirtyContext.Provider value={dirty}>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        {children}
      </Dialog>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              This form has unsaved data. Closing it now will lose everything you entered.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(false);
                onOpenChange(false);
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DirtyContext.Provider>
  );
}

export const TransactionDialogContent = React.forwardRef<
  React.ElementRef<typeof DialogContent>,
  React.ComponentPropsWithoutRef<typeof DialogContent>
>(({ className, onInteractOutside, ...props }, ref) => {
  const dirty = React.useContext(DirtyContext);
  return (
    <DialogContent
      ref={ref}
      className={cn(
        // Phones: near-fullscreen sheet. Desktop (sm:+) keeps the classic
        // centered dialog — pages override the width via `sm:max-w-*`; the
        // height cap comes from the base DialogContent (sm:max-h-[85vh]).
        'w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] max-h-[calc(100dvh-1rem)]',
        'sm:w-full sm:max-w-lg',
        // No horizontal scrolling ever; long item/ledger names wrap instead.
        'overflow-y-auto overflow-x-hidden break-words',
        className,
      )}
      onInteractOutside={e => {
        // Outside clicks NEVER close a transaction window — dirty or not.
        // Closing is always deliberate: Escape, the ✕ button, or a Cancel
        // button (each still guarded by the dirty confirmation above).
        void dirty;
        e.preventDefault();
        onInteractOutside?.(e);
      }}
      {...props}
    />
  );
});
TransactionDialogContent.displayName = 'TransactionDialogContent';
