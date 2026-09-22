import type { ThemeSourcePushDebt, ThemeSourceWindowProbe } from './theme-source-pushes.ts';

const _answeredProbeCarriesNoCause: ThemeSourceWindowProbe = {
  id: 1,
  url: 'file:///app/index.html#/doc',
  bridge: 'present',
  loading: false,
};
void _answeredProbeCarriesNoCause;

// @ts-expect-error -- a bridge that answered has no failure to describe; a cause on 'present' is stale text outliving the outcome it names.
const _presentWithCause: ThemeSourceWindowProbe = {
  id: 2,
  url: 'file:///app/index.html#/doc',
  bridge: 'present',
  loading: false,
  cause: 'Render frame was disposed',
};
void _presentWithCause;

// @ts-expect-error -- 'absent' is a bridgeless window, not a failed probe; nothing failed for a cause to quote.
const _absentWithCause: ThemeSourceWindowProbe = {
  id: 3,
  url: 'http://localhost:3030/',
  bridge: 'absent',
  loading: false,
  cause: 'bridge probe went unanswered for 2000ms',
};
void _absentWithCause;

// @ts-expect-error -- a rejected probe must quote what rejected it; the .catch arm always supplies one.
const _rejectedWithoutCause: ThemeSourceWindowProbe = {
  id: 4,
  url: 'file:///app/index.html#/stalled',
  bridge: 'probe-rejected',
  loading: false,
};
void _rejectedWithoutCause;

// @ts-expect-error -- an unanswered probe must name the bound it waited on; the abandon timer always supplies one.
const _unansweredWithoutCause: ThemeSourceWindowProbe = {
  id: 5,
  url: 'file:///app/index.html#/silent',
  bridge: 'probe-unanswered',
  loading: false,
};
void _unansweredWithoutCause;

const _builtElsewhere = {
  id: 6,
  url: 'file:///app/index.html#/doc',
  bridge: 'present' as const,
  loading: false,
  cause: 'stale error text',
};
// @ts-expect-error -- the pairing must hold through a widened variable, where excess-property checking does not fire; `cause?: never` is what rejects it.
const _widenedProbe: ThemeSourceWindowProbe = _builtElsewhere;
void _widenedProbe;

// @ts-expect-error -- 'owes' means the bridge answered and simply has not pushed yet; there is no failure to quote.
const _owesWithCause: ThemeSourcePushDebt = {
  id: 7,
  url: 'file:///app/index.html#/doc',
  reason: 'owes',
  cause: 'Render frame was disposed',
};
void _owesWithCause;

const _loadingMayCarryARejectionCause: ThemeSourcePushDebt = {
  id: 8,
  url: 'file:///app/index.html#/booting',
  reason: 'loading',
  cause: 'Render frame was disposed',
};
void _loadingMayCarryARejectionCause;
