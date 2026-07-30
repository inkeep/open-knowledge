/**
 * The "you turned it on — here's where to set it up" notice, shared by every
 * per-scope Plugins manage page (This project → Plugins, User → Plugins).
 *
 * Enabling happens on the manage list, but a plugin is CONFIGURED on its own
 * panel in the Plugins sidebar group — a separate surface the enable gesture
 * gives no path to, and one that can sit scrolled off screen. Without this the
 * plugin appears to turn on and do nothing. The action deep-links to that panel
 * through the settings hash, so it lands whether the dialog is still open or a
 * later click reopens it.
 *
 * Not a React module on purpose: the toast fires from a `Switch` handler, so it
 * needs the `@lingui/core/macro` `t` (resolved at call time, inside the
 * function — never at module scope, which would freeze the boot locale).
 */

import { t } from '@lingui/core/macro';
import { toast } from 'sonner';
import { openPluginSettings } from '@/lib/use-settings-route';

/** How long the notice stays up — longer than the default so it can be read AND clicked. */
const NOTICE_DURATION_MS = 8000;

export interface PluginEnabledNotice {
  /** Plugin id, as used by the `plugin:<id>` sidebar section. */
  pluginId: string;
  /** Display name, e.g. `Frontmatter schemas`. */
  label: string;
}

/**
 * Announce a just-enabled plugin and offer its settings panel. Toggling the
 * same plugin repeatedly replaces the notice instead of stacking (fixed id).
 */
export function notifyPluginEnabled({ pluginId, label }: PluginEnabledNotice): void {
  toast.success(t`${label} enabled`, {
    id: `plugin-enabled-${pluginId}`,
    description: t`Set it up on its own page under Plugins.`,
    duration: NOTICE_DURATION_MS,
    action: {
      label: t`Open settings`,
      onClick: () => openPluginSettings(pluginId),
    },
  });
}
