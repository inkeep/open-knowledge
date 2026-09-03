export interface MarketingMarkdownPage {
  readonly path: string;
  readonly section: 'Blog' | 'Product';
  readonly name: string;
  readonly description: string;
}

export const MARKETING_MARKDOWN_PAGES: readonly MarketingMarkdownPage[] = [
  {
    path: '/index.md',
    section: 'Product',
    name: 'OpenKnowledge',
    description: 'What it is, how to get it, and where everything else lives.',
  },
  {
    path: '/download.md',
    section: 'Product',
    name: 'Download',
    description: 'Direct installer URLs for every macOS, Windows, and Linux build.',
  },
  {
    path: '/team.md',
    section: 'Product',
    name: 'Team',
    description: 'Who builds OpenKnowledge, and the rendition of each profile.',
  },
  {
    path: '/brand.md',
    section: 'Product',
    name: 'Brand',
    description: 'Logo and icon files, and the rules for using them.',
  },
  {
    path: '/blog.md',
    section: 'Blog',
    name: 'Blog index',
    description: 'Every published post with its title, date, and summary.',
  },
];
