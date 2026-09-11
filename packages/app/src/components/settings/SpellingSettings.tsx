import { SpellcheckLanguagesRow } from './SpellcheckLanguagesRow';
import { SpellcheckRow } from './SpellcheckRow';
import { isOkDesktopHost } from './settings-host-gates';

export function SpellingSettings() {
  if (!isOkDesktopHost()) return null;
  return (
    <div className="flex flex-col gap-10" data-testid="settings-spelling">
      <SpellcheckRow />
      <SpellcheckLanguagesRow />
    </div>
  );
}
