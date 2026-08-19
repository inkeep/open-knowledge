// FIXTURE — drives `no-demoted-dialog-confirm.test.ts` via shell-out to
// `biome check`. Not part of the main lint (lives outside the lint
// command's path list).
//
// Three positive cases (deliberate violations — plugin must fire) + four
// negative cases (clean usage that must NOT fire). Exact-equality
// (`toBe(3)`) in the test catches both false-negative regressions (drop
// below 3) and false-positive widenings (above 3).

import { AlertDialogFooter } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { DialogClose, DialogFooter } from '@/components/ui/dialog';

declare const close: () => void;
declare const submit: () => void;

// === Positive cases — must fire ===

// (1) The reported shape: an outline dismiss beside a secondary confirm.
//     The confirm hand-adds the mono treatment that `default` would have
//     supplied, which is what makes the inversion easy to author by
//     accident — the footer still LOOKS like a footer.
export function Positive1() {
  return (
    <DialogFooter>
      <Button variant="outline" onClick={close}>
        Cancel
      </Button>
      <Button variant="secondary" className="font-mono uppercase" onClick={submit}>
        Enable indexes
      </Button>
    </DialogFooter>
  );
}

// (2) Same inversion with the dismiss wrapped in `DialogClose asChild`,
//     which is the other way this footer gets written.
export function Positive2() {
  return (
    <DialogFooter>
      <DialogClose asChild>
        <Button variant="outline">Cancel</Button>
      </DialogClose>
      <Button variant="secondary" onClick={submit}>
        Install selected
      </Button>
    </DialogFooter>
  );
}

// (3) AlertDialogFooter — the sibling footer primitive. Same predicate.
export function Positive3() {
  return (
    <AlertDialogFooter>
      <Button variant="outline" onClick={close}>
        Cancel
      </Button>
      <Button variant="secondary" onClick={submit}>
        Confirm
      </Button>
    </AlertDialogFooter>
  );
}

// === Negative cases — must NOT fire ===

// (1) The canonical shape: the confirm omits the variant entirely and takes
//     `default` from `defaultVariants`.
export function Negative1() {
  return (
    <DialogFooter>
      <Button variant="outline" onClick={close}>
        Cancel
      </Button>
      <Button onClick={submit}>Publish</Button>
    </DialogFooter>
  );
}

// (2) `destructive` confirm — correct for irreversible removal, and it
//     outranks the dismiss. Must NOT fire.
export function Negative2() {
  return (
    <DialogFooter>
      <Button variant="outline" onClick={close}>
        Cancel
      </Button>
      <Button variant="destructive" onClick={submit}>
        Delete permanently
      </Button>
    </DialogFooter>
  );
}

// (3) `variant="secondary"` OUTSIDE a footer. The rule is scoped to the
//     footer element, and a muted action elsewhere is a legitimate choice.
//     Must NOT fire.
export function Negative3() {
  return (
    <div className="card-actions">
      <Button variant="secondary" onClick={submit}>
        Install skill
      </Button>
    </div>
  );
}

// (4) A footer holding a deliberately muted tertiary control alongside a
//     properly-weighted confirm, suppressed inline. Exercises the escape
//     hatch the diagnostic names.
export function Negative4() {
  return (
    // biome-ignore lint/plugin/no-demoted-dialog-confirm: tertiary control beside a correctly-weighted confirm
    <DialogFooter>
      <Button variant="secondary" onClick={close}>
        Remind me later
      </Button>
      <Button onClick={submit}>Update now</Button>
    </DialogFooter>
  );
}
