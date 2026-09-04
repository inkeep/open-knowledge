import { useSyncExternalStore } from 'react';
import {
  type ContactEmailState,
  type ContactEmailStore,
  contactEmailStore,
} from '@/lib/contact-email-store';

export function useContactEmail(store: ContactEmailStore = contactEmailStore): ContactEmailState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
