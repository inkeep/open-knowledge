// FIXTURE: drives `no-redundant-jsx-element-braces.uncached.test.ts` via
// shell-out to oxlint. Not part of the main lint: `__fixtures__/` is in
// `oxlint.config.ts#ignorePatterns`, and `__fixtures__/oxlint.fixtures.json`
// re-enables the rules for the test.
//
// The custom rule covers what `react/jsx-curly-brace-presence` skips: braces
// around one child element when the braces hold a comment. 4 positive cases
// (custom rule MUST fire) and 6 negative cases (custom rule must NOT fire).
// Negative (6) is the plain shape, which the built-in rule reports instead.

declare const ok: boolean;
declare function Icon(): null;
declare function Wrapper(props: { icon: unknown }): null;

// === Positive cases: must fire ===

// (1) A comment between the element's props.
export function PositivePropComment() {
  return (
    <div>
      {
        <section
          // note
          id="a"
        >
          x
        </section>
      }
    </div>
  );
}

// (2) A directive on a child inside the element.
export function PositiveChildDirective() {
  return (
    <div>
      {
        <section>
          {/* biome-ignore lint/a11y/useSemanticElements: fixture */}
          <div role="group" />
        </section>
      }
    </div>
  );
}

// (3) A prose comment before the element, inside the braces.
export function PositiveLeadingProse() {
  return (
    <div>
      {
        // prose
        <b>x</b>
      }
    </div>
  );
}

// (4) A trailing block comment after the element.
export function PositiveTrailingComment() {
  return <div>{<b>x</b> /* trailing */}</div>;
}

// === Negative cases: must NOT fire ===

// (5) Boundary: a lone biome-ignore before the element is the one comment
// the braces may carry.
export function NegativeLeadingDirective() {
  return (
    <div>
      {
        // biome-ignore lint/a11y/useSemanticElements: fixture
        <div role="group" />
      }
    </div>
  );
}

// (6) Boundary: no comment at all. `react/jsx-curly-brace-presence` reports it.
export function NegativePlain() {
  return <p>{<b>x</b>}</p>;
}

// (7) An element as an attribute value needs the braces.
export function NegativeAttribute() {
  return <Wrapper icon={<Icon />} />;
}

// (8) A conditional is an expression, not a lone element.
export function NegativeConditional() {
  return <div>{ok ? <b>x</b> : null}</div>;
}

// (9) A logical expression is an expression, not a lone element.
export function NegativeLogical() {
  return <div>{ok && <b>x</b>}</div>;
}

// (10) A fragment with no comment is the built-in rule's case too.
export function NegativePlainFragment() {
  return (
    <div>
      {
        <>
          <Icon />
        </>
      }
    </div>
  );
}
