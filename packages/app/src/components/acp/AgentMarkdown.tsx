import { useLingui } from '@lingui/react/macro';
import { type ReactNode, use } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { type Components, defaultRemarkPlugins, Streamdown } from 'streamdown';
import { codeHighlighter } from '@/lib/acp/code-highlighter';
import { remarkHardBreaks } from '@/lib/acp/remark-hard-breaks';
import { remarkUntrustedContent } from '@/lib/acp/remark-untrusted-content';
import { docNameFromHash } from '@/lib/doc-hash';
import { cn } from '@/lib/utils';
import { remarkDocPathLinks } from './doc-path-links';
import { DocPathResolverReadyContext } from './doc-path-links-context';
import { GitHubReferenceLink } from './GitHubReferenceCard';
import { isGitHubReferenceHref } from './github-reference';
import { referenceRulesKey, remarkReferenceLinks } from './reference-links';
import { ReferenceRulesContext } from './reference-links-context';

const EXTERNAL_LINK_CLASS = 'wrap-anywhere font-medium text-primary underline';

function AgentAnchor(props: { href?: string; children?: ReactNode }): ReactNode {
  const { t } = useLingui();
  const { href, children } = props;
  if (href?.startsWith('#/')) {
    const docName = docNameFromHash(href) ?? href;
    return (
      <a
        href={href}
        data-testid="agent-thread-doc-link"
        title={t`Open ${docName}`}
        className="text-primary underline underline-offset-2 decoration-primary/40 hover:decoration-primary"
      >
        {children}
      </a>
    );
  }
  if (isGitHubReferenceHref(href)) {
    return (
      <GitHubReferenceLink href={href} className={EXTERNAL_LINK_CLASS}>
        {children}
      </GitHubReferenceLink>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-streamdown="link"
      className={EXTERNAL_LINK_CLASS}
    >
      {children}
    </a>
  );
}

export function AgentMarkdown({
  text,
  className,
  untrusted = false,
}: {
  text: string;
  className?: string;
  untrusted?: boolean;
}): ReactNode {
  const resolverReady = use(DocPathResolverReadyContext);
  const referenceRules = use(ReferenceRulesContext);
  return (
    <ErrorBoundary
      resetKeys={[text]}
      fallbackRender={() => <span className="whitespace-pre-wrap">{text}</span>}
      onError={(error) => {
        console.error('[AgentMarkdown] markdown render failed, falling back to plain text', error);
      }}
    >
      <Streamdown
        key={`${resolverReady ? 'with-resolver' : 'no-resolver'}:${referenceRulesKey(referenceRules)}`}
        className={cn(
          '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_pre_code>span]:block [&_ol]:list-outside [&_ul]:list-outside [&_ol]:ps-6 [&_ul]:ps-6 [&_li+li]:mt-2 [&_li>p]:block! [&_li>*+*]:mt-2 [&_li_[data-streamdown=code-block]]:my-2! [&_code]:text-1sm [&_pre]:text-1sm [&_[data-streamdown=code-block-body]]:p-3 [&_[data-streamdown=code-block-body]]:max-h-80 [&_[data-streamdown=code-block-body]]:overflow-auto',
          className,
        )}
        remarkPlugins={[
          ...Object.values(defaultRemarkPlugins),
          remarkHardBreaks,
          ...(untrusted ? [remarkUntrustedContent()] : []),
          remarkDocPathLinks(),
          [remarkReferenceLinks, referenceRules],
        ]}
        components={{ a: AgentAnchor } as Components}
        lineNumbers={false}
        controls={{ code: { copy: true, download: false }, table: false, mermaid: false }}
        plugins={{ code: codeHighlighter }}
        linkSafety={{ enabled: false }}
      >
        {text}
      </Streamdown>
    </ErrorBoundary>
  );
}
