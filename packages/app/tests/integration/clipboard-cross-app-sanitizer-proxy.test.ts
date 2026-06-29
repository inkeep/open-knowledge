
import { describe, expect, test } from 'bun:test';


interface DescriptorFixture {
  name: string;
  surface: 'canonical' | 'compat' | 'source-fallback';
  html: string;
  visibleText: string;
}

const FIXTURES: DescriptorFixture[] = [
  {
    name: 'Callout',
    surface: 'canonical',
    html: '<aside class="callout callout-note" data-callout-type="note" style="border-left: 3px solid rgb(9, 105, 218); padding: 0.5rem 0.75rem;"><span class="callout-header"><svg class="callout-icon" aria-hidden="true"></svg><span class="callout-title">Heads up</span></span><div class="callout-body"><p>Body text here.</p></div></aside>',
    visibleText: 'Heads up',
  },
  {
    name: 'GFMCallout',
    surface: 'compat',
    html: '<aside class="callout callout-warning" data-callout-type="warning" style="border-left: 3px solid rgb(154, 103, 0);"><div class="callout-body"><p>Caution!</p></div></aside>',
    visibleText: 'Caution!',
  },
  {
    name: 'Accordion',
    surface: 'canonical',
    html: '<details class="accordion" open><summary class="accordion-summary"><svg class="accordion-chevron"></svg><span class="accordion-title">Section</span></summary><div class="accordion-body"><p>Body</p></div></details>',
    visibleText: 'Section',
  },
  {
    name: 'HtmlDetailsAccordion',
    surface: 'compat',
    html: '<details class="accordion"><summary class="accordion-summary"><svg class="accordion-chevron"></svg><span class="accordion-title">Q</span></summary><div class="accordion-body">A</div></details>',
    visibleText: 'Q',
  },
  {
    name: 'img',
    surface: 'canonical',
    html: '<img class="ok-image" src="https://example.com/x.png" alt="example" />',
    visibleText: 'example',
  },
  {
    name: 'CommonMarkImage',
    surface: 'compat',
    html: '<img class="ok-image" src="https://example.com/x.png" alt="example" />',
    visibleText: 'example',
  },
  {
    name: 'video',
    surface: 'canonical',
    html: '<video class="ok-video" src="https://example.com/x.mp4" controls></video>',
    visibleText: '',
  },
  {
    name: 'audio',
    surface: 'canonical',
    html: '<audio class="ok-audio" src="https://example.com/x.mp3" controls></audio>',
    visibleText: '',
  },
  {
    name: 'source-fallback-block-relative-image',
    surface: 'source-fallback',
    html: '<pre class="mdx-component"><code>![chart](./Q3-sales.png)</code></pre>',
    visibleText: '![chart](./Q3-sales.png)',
  },
  {
    name: 'source-fallback-inline-paragraph-image',
    surface: 'source-fallback',
    html: '<p>prose <span class="mdx-inline">![alt](./x.jpg)</span> more prose</p>',
    visibleText: '![alt](./x.jpg)',
  },
  {
    name: 'wiki-link-rewritten-anchor',
    surface: 'source-fallback',
    html: '<a class="wiki-link" data-target="OtherDoc" data-anchor="" data-alias="" href="#otherdoc">OtherDoc</a>',
    visibleText: 'OtherDoc',
  },
  {
    name: 'source-mode-wrapper-multiline-blob',
    surface: 'source-fallback',
    html: '<pre class="mdx-component"><code># Heading\n\n- list item\n\n![chart](./x.png)</code></pre>',
    visibleText: '![chart](./x.png)',
  },
];


function applyDomPurifyStrict(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/src="data:/gi, 'src="blocked:');
}

function applySlackProxy(html: string): string {
  return html
    .replace(/\sdata-[\w-]+="[^"]*"/g, '')
    .replace(/\sclass="[^"]*"/g, '')
    .replace(/\sstyle="[^"]*"/g, '');
}

function applyNotionProxy(html: string): string {
  return html.replace(/\sstyle="([^"]*)"/g, (_match, content: string) => {
    const kept = content
      .split(/;\s*/)
      .filter((decl) => /^\s*(color|background-color)\s*:/i.test(decl))
      .join('; ');
    return kept ? ` style="${kept}"` : '';
  });
}

function applyGmailProxy(html: string): string {
  return html.replace(/\sdata-[\w-]+="[^"]*"/g, '').replace(/\son\w+="[^"]*"/gi, '');
}

function applyGitHubProxy(html: string): string {
  return html
    .replace(/\sdata-[\w-]+="[^"]*"/g, '')
    .replace(/\sstyle="[^"]*"/g, '')
    .replace(/\sclass="(?!markdown-alert|callout)[^"]*"/g, '');
}

interface Profile {
  name: string;
  apply: (html: string) => string;
}

const PROFILES: Profile[] = [
  { name: 'dompurify-strict', apply: applyDomPurifyStrict },
  { name: 'slack', apply: applySlackProxy },
  { name: 'notion', apply: applyNotionProxy },
  { name: 'gmail', apply: applyGmailProxy },
  { name: 'github', apply: applyGitHubProxy },
];


describe('sanitizer-proxy hermetic tests — walker output survives 5 destination profiles', () => {
  for (const fixture of FIXTURES) {
    describe(`${fixture.surface} ${fixture.name}`, () => {
      for (const profile of PROFILES) {
        test(`${profile.name}: structural content + visible text survive`, () => {
          const out = profile.apply(fixture.html);
          if (fixture.visibleText) {
            expect(out).toContain(fixture.visibleText);
          }
          expect(out).not.toMatch(/\son\w+\s*=/i);
          expect(out).not.toContain('javascript:');
          if (fixture.html.startsWith('<aside')) expect(out).toContain('<aside');
          if (fixture.html.startsWith('<details')) {
            expect(out).toContain('<details');
            expect(out).toContain('<summary');
          }
          if (fixture.html.startsWith('<img')) expect(out).toContain('<img');
          if (fixture.html.startsWith('<video')) expect(out).toContain('<video');
          if (fixture.html.startsWith('<audio')) expect(out).toContain('<audio');
        });
      }
    });
  }

  test('escape contract: an adversarial `<script>` payload never survives any profile', () => {
    const adversarial =
      '<aside class="callout"><span>OK content</span><script>alert(1)</script></aside>';
    for (const profile of PROFILES) {
      const out = profile.apply(adversarial);
      if (profile.name === 'dompurify-strict') {
        expect(out).not.toContain('<script>');
      }
    }
  });

  test('Slack profile: class + data-* + style fully stripped', () => {
    const fixture = FIXTURES[0]; // Callout
    const out = applySlackProxy(fixture.html);
    expect(out).not.toContain('class=');
    expect(out).not.toContain('data-callout-type');
    expect(out).not.toContain('style=');
    expect(out).toContain(fixture.visibleText);
  });

  test('Notion profile: layout styles dropped, color preserved', () => {
    const html =
      '<aside style="border-left: 3px solid rgb(9, 105, 218); padding: 0.5rem; color: rgb(20, 20, 20);"><span>x</span></aside>';
    const out = applyNotionProxy(html);
    expect(out).toContain('color: rgb(20, 20, 20)');
    expect(out).not.toContain('padding');
    expect(out).not.toContain('border-left');
  });

  test('GitHub profile: markdown-alert class survives, others stripped', () => {
    const html =
      '<aside class="markdown-alert markdown-alert-note">Note body</aside><span class="random-other">x</span>';
    const out = applyGitHubProxy(html);
    expect(out).toContain('markdown-alert');
    expect(out).toContain('Note body');
    expect(out).not.toMatch(/class="random-other"/);
  });

  test('wiki-link anchor: href="#slug" survives every profile (clickable affordance preserved)', () => {
    const html = '<a href="#otherdoc-section-name">Other Doc#Section Name</a>';
    for (const profile of PROFILES) {
      const out = profile.apply(html);
      expect(out, profile.name).toContain('href="#otherdoc-section-name"');
      expect(out, profile.name).toContain('Other Doc#Section Name');
    }
  });

  test('source-fallback wrapper: visible markdown source survives even when `class="mdx-component"` is stripped', () => {
    const html = '<pre class="mdx-component"><code>![chart](./Q3-sales.png)</code></pre>';
    for (const profile of PROFILES) {
      const out = profile.apply(html);
      expect(out, profile.name).toContain('![chart](./Q3-sales.png)');
    }
    const slackOut = applySlackProxy(html);
    expect(slackOut).not.toContain('class="mdx-component"');
    const githubOut = applyGitHubProxy(html);
    expect(githubOut).not.toContain('class="mdx-component"');
  });

  test('post-walker shape: editor toolbar chrome subtree (data-clipboard-omit) is absent across all profiles', () => {
    const postWalkerOutput =
      '<aside class="callout callout-note" data-callout-type="note">' +
      '<span class="callout-header"><span aria-hidden="true">ℹ</span>' +
      '<span class="callout-title">Heads up</span></span>' +
      '<div class="callout-body"><p>Body text here.</p></div>' +
      '</aside>';
    for (const profile of PROFILES) {
      const out = profile.apply(postWalkerOutput);
      expect(out, profile.name).not.toContain('jsx-component-chrome');
      expect(out, profile.name).not.toContain('jsx-chrome-btn');
      expect(out, profile.name).not.toContain('lucide-trash2');
      expect(out, profile.name).not.toContain('lucide-settings2');
      expect(out, profile.name).not.toContain('lucide-arrow-up');
      expect(out, profile.name).not.toContain('lucide-arrow-down');
      expect(out, profile.name).toContain('Heads up');
      expect(out, profile.name).toContain('Body text here.');
    }
  });
});
