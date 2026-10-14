import type { KeyboardEvent } from 'react';

const SAFARI_IME_CONFIRM_KEY_CODE = 229;

export function isImeCompositionKey(event: KeyboardEvent): boolean {
  return (
    event.nativeEvent.isComposing ||
    // oxlint-disable-next-line typescript/no-deprecated -- Safari fires the IME-confirming Enter after compositionend with isComposing false; keyCode 229 is the only signal it carries
    event.keyCode === SAFARI_IME_CONFIRM_KEY_CODE
  );
}
