import { registerCustomTheme } from '@pierre/diffs';
import { OK_SYNTAX_THEME_NAME, okSyntaxTheme } from './ok-syntax-theme';

let registered = false;

export function okPierreTheme(): string {
  if (!registered) {
    registerCustomTheme(OK_SYNTAX_THEME_NAME, () => Promise.resolve(okSyntaxTheme));
    registered = true;
  }
  return OK_SYNTAX_THEME_NAME;
}
