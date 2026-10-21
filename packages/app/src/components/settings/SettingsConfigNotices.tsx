import { CONFIG_DOC_NAMES } from '@inkeep/open-knowledge-core/constants/cc1';
import { DocChangeNotice } from '@/components/DocChangeNotice';

export function SettingsConfigNotices({ onDismissFocus }: { onDismissFocus: () => void }) {
  return (
    <div
      data-testid="settings-config-notices"
      className="has-[section]:-mx-6 has-[section]:-mt-6 has-[section]:mb-6"
    >
      {CONFIG_DOC_NAMES.map((docName) => (
        <DocChangeNotice
          key={docName}
          docName={docName}
          timelineAvailable={false}
          fileLabel="path"
          onDismissFocus={onDismissFocus}
        />
      ))}
    </div>
  );
}
