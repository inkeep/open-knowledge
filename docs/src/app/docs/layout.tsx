import { getGitHubStars } from '@inkeep/open-knowledge-core';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { DocsSidebarCta } from '@/components/docs-sidebar-cta';
import { DocsSidebarItem } from '@/components/docs-sidebar-item';
import { DocsSidebarSeparator } from '@/components/docs-sidebar-separator';
import { baseOptions } from '@/lib/layout.shared';
import { source } from '@/lib/source';

export default async function Layout({ children }: LayoutProps<'/docs'>) {
  const stars = await getGitHubStars({ next: { revalidate: 3600 } });
  return (
    <DocsLayout
      tree={source.pageTree}
      sidebar={{
        banner: <DocsSidebarCta stars={stars} />,
        components: { Item: DocsSidebarItem, Separator: DocsSidebarSeparator },
      }}
      {...baseOptions({ wordmarkClassName: 'h-7 w-auto text-(--slide-text)' })}
    >
      {children}
    </DocsLayout>
  );
}
