import type { UninstallScreenSpec } from '@inkeep/open-knowledge-core';
import { Trans } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { requestUninstallScreen, sendUninstallIntent } from './bridge';
import { UninstallNoticeScreen } from './UninstallNoticeScreen';
import { UninstallPickerScreen } from './UninstallPickerScreen';
import { UninstallProgressScreen } from './UninstallProgressScreen';
import { UninstallSurveyScreen } from './UninstallSurveyScreen';

/**
 * Root of the uninstall renderer.
 *
 * Main decides which screen this window is and answers the `ready` pull with
 * it; the window itself carries no flow state. The fallback below is the gap
 * between first paint and main's answer, not a screen of its own.
 */
export function UninstallApp() {
  const [screen, setScreen] = useState<UninstallScreenSpec | null>(null);

  useEffect(() => {
    let live = true;
    void requestUninstallScreen().then((next) => {
      if (live) setScreen(next);
    });
    return () => {
      live = false;
    };
  }, []);

  if (screen !== null) {
    switch (screen.kind) {
      case 'picker':
        return (
          <UninstallPickerScreen
            projects={screen.projects}
            onConfirm={(selectedIndexes) =>
              sendUninstallIntent({ kind: 'picker-confirm', selectedIndexes })
            }
            onCancel={() => sendUninstallIntent({ kind: 'picker-cancel' })}
          />
        );
      case 'survey':
        return (
          <UninstallSurveyScreen
            onSend={(answers) => sendUninstallIntent({ kind: 'survey-send', ...answers })}
            onSkip={() => sendUninstallIntent({ kind: 'survey-skip' })}
          />
        );
      case 'progress':
        return <UninstallProgressScreen />;
      case 'notice':
        return (
          <UninstallNoticeScreen
            notice={screen.notice}
            onConfirm={() => sendUninstallIntent({ kind: 'notice-confirm' })}
            onCancel={() => sendUninstallIntent({ kind: 'notice-cancel' })}
            onRevealLog={() => sendUninstallIntent({ kind: 'notice-reveal-log' })}
          />
        );
      default: {
        // A new UninstallScreenSpec kind must add a case above rather than
        // silently falling through to the loading placeholder below.
        const _exhaustive: never = screen;
        return _exhaustive;
      }
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-8 text-foreground">
      <p className="text-center text-muted-foreground text-sm">
        <Trans>Preparing to uninstall OpenKnowledge</Trans>
      </p>
    </main>
  );
}
