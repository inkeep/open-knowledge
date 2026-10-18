import { t } from '@lingui/core/macro';
import * as sonner from 'sonner';
import { toast } from 'sonner';
import { toast as sonnerToast } from 'sonner';
import { toast as appToast } from '@/lib/app-toast';
import * as appToasts from '@/lib/app-toasts';

declare function errorText(value: unknown): string;
declare function humanFormat(value: unknown): string;
declare const err: Error;
declare const error: Error;
declare const e: Error;
declare const cause: unknown;
declare const saveError: Error;
declare const ex: Error;
declare const reason: Error;
declare const lastErr: Error;
declare const failed: boolean;
declare const result: { ok: false; error: string; message: string; detail: string };
declare const frame: { message: string };
declare const message: string;
declare const name: string;
declare const isError: boolean;
declare const ui: { error: (message: string) => void };

export function positives(): void {
  toast.error(err.message);
  toast.error(err instanceof Error ? err.message : t`Couldn't save the page.`);
  toast.error(String(cause));
  toast.error(errorText(cause));
  toast.error(e.toString());
  toast.error(t`Couldn't save ${name}: ${error.message}`);
  toast.error(t`Couldn't save ${name}: ${errorText(err)}`);
  toast.error(`Couldn't save: ${saveError}`);
  toast.error(t`Couldn't move the skill: ${result.error}`);
  toast.error(result.error);
  toast.warning(err?.message ?? t`Couldn't sync.`);
  toast.info('Sync stopped: ' + err.message);
  toast(err.message);
  toast.success(err.message);
  toast.loading(err.message);
  toast.message(err.message);
  toast.error(t`Couldn't save the page.`, { description: err.message });
  toast.error(t`Couldn't import the template.`, { description: result.error });
  sonnerToast.error(err.message);
  sonner.toast.error(err.message);
  toast.error(failed && err.message);
  toast.error(ex.message);
  toast.error(reason.message);
  toast.error(lastErr.message);
  toast.error(t`Couldn't save the page.`, { 'description': err.message });
}

export function negatives(): void {
  toast.error(t`Couldn't save the page.`);
  toast.error(t`Couldn't save ${name}.`);
  toast.error(message);
  toast.error(result.message);
  toast.error(frame.message);
  toast.error(t`Couldn't save the page.`, { description: result.detail });
  toast.error(t`Couldn't save the page.`, { description: humanFormat(result.error) });
  toast.error(isError && t`Couldn't save the page.`);
  toast.error(String(name));
  ui.error(err.message);
  toast.custom(() => null, { description: err.message });
  appToast.error(err.message);
  appToasts.toast.error(err.message);
}

export function localToast(): void {
  const toast = { error: (text: string) => text };
  toast.error(err.message);
}
