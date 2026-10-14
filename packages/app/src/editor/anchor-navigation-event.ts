export const REPEAT_ANCHOR_NAV_EVENT = 'open-knowledge:repeat-anchor-nav';

export function requestRepeatAnchorNavigation(): void {
  window.dispatchEvent(new Event(REPEAT_ANCHOR_NAV_EVENT));
}
