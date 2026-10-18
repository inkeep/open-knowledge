import * as sonner from 'sonner';
import { toast } from 'sonner';
import { toast as sonnerToast } from 'sonner';
import { toast as appToast } from '@/lib/app-toast';
import * as appToasts from '@/lib/app-toasts';

declare const ui: { custom: (render: () => null) => void };

export function positives(): void {
  toast.custom(() => null);
  sonnerToast.custom(() => null, { id: 'p2-aliased-import' });
  sonner.toast.custom(() => null);
}

export function negatives(): void {
  toast('n1 base call');
  toast.success('n2 typed success');
  toast.error('n3 typed error');
  toast.warning('n4 typed warning');
  toast.info('n5 typed info');
  toast.loading('n6 typed loading');
  ui.custom(() => null);
  const n7 = toast.custom;
  void n7;
  appToast.custom(() => null);
  appToasts.toast.custom(() => null);
}

export function localToast(): void {
  const toast = { custom: (render: () => null) => render() };
  toast.custom(() => null);
}
