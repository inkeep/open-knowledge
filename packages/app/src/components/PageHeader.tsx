import type { HocuspocusProvider } from '@hocuspocus/provider';
import {
  bindFrontmatterDoc,
  type FrontmatterSnapshot,
  readFmKeys,
  readFmRegionWithError,
} from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';
import {
  type ResolvedPageCover,
  type ResolvedPageIcon,
  resolvePageCover,
  resolvePageIcon,
} from '@/components/page-header-utils';

interface PageHeaderProps {
  provider: HocuspocusProvider;
}

function readInitialSnapshot(provider: HocuspocusProvider): FrontmatterSnapshot {
  const ytext = provider.document.getText('source').toString();
  const { map, parseError } = readFmRegionWithError(ytext);
  const keys = readFmKeys(ytext);
  return { map, keys, parseError };
}

export function PageHeader({ provider }: PageHeaderProps) {
  const [snapshot, setSnapshot] = useState<FrontmatterSnapshot>(() =>
    readInitialSnapshot(provider),
  );

  useEffect(() => {
    const next = bindFrontmatterDoc(provider);
    setSnapshot(next.current());
    const unsub = next.subscribe((s) => {
      setSnapshot(s);
    });
    return () => {
      unsub();
      next.dispose();
    };
  }, [provider]);

  const icon = resolvePageIcon(snapshot.map.icon);
  const cover = resolvePageCover(snapshot.map.cover);

  const hasCover = cover.kind === 'url' || cover.kind === 'path';
  const hasIcon = icon.kind !== 'unsupported';

  if (!hasCover && !hasIcon) return null;

  return (
    <div
      className="page-header editor-content-aligned"
      data-has-cover={hasCover ? 'true' : 'false'}
      data-has-icon={hasIcon ? 'true' : 'false'}
      aria-hidden="true"
      data-testid="page-header"
    >
      {hasCover ? <CoverBanner cover={cover} /> : null}
      {hasIcon ? <PageIconBlock icon={icon} hasCover={hasCover} /> : null}
    </div>
  );
}

function CoverBanner({ cover }: { cover: ResolvedPageCover }) {
  return (
    <div className="page-header-cover" data-testid="page-header-cover">
      <img
        src={cover.value}
        alt=""
        draggable={false}
        loading="lazy"
        referrerPolicy="no-referrer"
        className="page-header-cover-img"
      />
    </div>
  );
}

function PageIconBlock({ icon, hasCover }: { icon: ResolvedPageIcon; hasCover: boolean }) {
  const overlay = hasCover ? 'page-header-icon page-header-icon--with-cover' : 'page-header-icon';
  if (icon.kind === 'emoji') {
    return (
      <span className={overlay} data-testid="page-header-icon" data-kind="emoji">
        {icon.value}
      </span>
    );
  }
  return (
    <span className={overlay} data-testid="page-header-icon" data-kind={icon.kind}>
      <img
        src={icon.value}
        alt=""
        draggable={false}
        referrerPolicy="no-referrer"
        className="page-header-icon-img"
      />
    </span>
  );
}
