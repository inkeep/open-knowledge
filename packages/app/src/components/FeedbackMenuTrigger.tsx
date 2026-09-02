import { useEffect, useState } from 'react';
import { FeedbackFormDialog } from '@/components/FeedbackFormDialog';
import { subscribeLocalMenuAction } from '@/lib/local-menu-action-bus';

export function FeedbackMenuTrigger() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    return subscribeLocalMenuAction((action) => {
      if (action === 'send-feedback') setOpen(true);
    });
  }, []);

  return <FeedbackFormDialog open={open} onOpenChange={setOpen} source="help_menu" />;
}
