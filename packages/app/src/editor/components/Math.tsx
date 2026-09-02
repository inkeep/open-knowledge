import { lazy, Suspense } from 'react';

interface MathProps {
  formula?: string;
  id?: string;
  language?: string;
}

const KatexRender = lazy(async () => {
  const { default: katex } = await import('katex');

  function KatexRenderInner(props: { formula: string; id?: string }) {
    const html = katex.renderToString(props.formula, {
      displayMode: true,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
    });
    return (
      <div
        className="math math-display"
        data-component-type="math"
        id={props.id}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX renderToString returns a strict HTML-allowlist string with no script execution; this is the documented integration path.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return { default: KatexRenderInner };
});

function MathPlaceholder(props: { formula: string; id?: string }) {
  return (
    <div className="math math-placeholder" data-component-type="math" id={props.id}>
      {props.formula || ' '}
    </div>
  );
}

export function MathView(props: MathProps) {
  const formula = props.formula ?? '';
  if (!formula) {
    return <MathPlaceholder formula={formula} id={props.id} />;
  }
  return (
    <Suspense fallback={<MathPlaceholder formula={formula} id={props.id} />}>
      <KatexRender formula={formula} id={props.id} />
    </Suspense>
  );
}
