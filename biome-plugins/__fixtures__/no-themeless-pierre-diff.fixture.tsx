// FIXTURE — drives `no-themeless-pierre-diff.test.ts` via shell-out to
// `biome check`. Not part of the main lint (lives outside the lint
// command's path list).
//
// Three positive cases (deliberate violations — plugin must fire) + two
// negative cases (clean usage that must NOT fire). Exact-equality in the
// test catches both false-negative regressions and false-positive
// widenings.

// biome-ignore lint/suspicious/noExplicitAny: fixture-only — production types unimportant here
declare const MultiFileDiff: any;
// biome-ignore lint/suspicious/noExplicitAny: fixture-only — production types unimportant here
declare const okPierreTheme: any;
// biome-ignore lint/suspicious/noExplicitAny: fixture-only — production types unimportant here
declare const oldFile: any;
// biome-ignore lint/suspicious/noExplicitAny: fixture-only — production types unimportant here
declare const newFile: any;
// biome-ignore lint/suspicious/noExplicitAny: fixture-only — production types unimportant here
declare const UnresolvedFile: any;
// biome-ignore lint/suspicious/noExplicitAny: fixture-only — production types unimportant here
declare const PierreFile: any;

// === Positive cases — must fire ===

// (1) No theme at all.
export function Positive1() {
  return <MultiFileDiff oldFile={oldFile} newFile={newFile} options={{ diffStyle: 'unified' }} />;
}

// (2) No diffStyle at all.
export function Positive2() {
  return <MultiFileDiff oldFile={oldFile} newFile={newFile} options={{ theme: okPierreTheme() }} />;
}

// (3) diffStyle explicitly split.
export function Positive3() {
  return (
    <MultiFileDiff
      oldFile={oldFile}
      newFile={newFile}
      options={{ diffStyle: 'split', theme: okPierreTheme() }}
    />
  );
}

// (4) A decoy `theme` token outside the options object.
export function Positive4() {
  return (
    <MultiFileDiff
      data-theme="dark"
      oldFile={oldFile}
      newFile={newFile}
      options={{ diffStyle: 'unified' }}
    />
  );
}

// (5) Child-bearing JSX form, no theme.
export function Positive5() {
  return (
    <MultiFileDiff oldFile={oldFile} newFile={newFile} options={{ diffStyle: 'unified' }}>
      {null}
    </MultiFileDiff>
  );
}

// (6) Constructor site, no theme.
export function positive6() {
  return new UnresolvedFile({ overflow: 'wrap' });
}

// === Negative cases — must NOT fire ===

// (1) Both theme and unified present.
export function Negative1() {
  return (
    <MultiFileDiff
      oldFile={oldFile}
      newFile={newFile}
      options={{ diffStyle: 'unified', theme: okPierreTheme() }}
    />
  );
}

// (2) Same, different property order.
export function Negative2() {
  return (
    <MultiFileDiff
      oldFile={oldFile}
      newFile={newFile}
      options={{ theme: okPierreTheme(), diffStyle: 'unified' }}
    />
  );
}

// (3) Constructor site with a theme.
export function negative3() {
  return new UnresolvedFile({ overflow: 'wrap', theme: okPierreTheme() });
}

// (positive) Aliased constructor surface without a theme.
export function PositivePierreFile() {
  return new PierreFile({ overflow: 'wrap' });
}

// (negative) Aliased constructor surface with a theme.
export function NegativePierreFile() {
  return new PierreFile({ overflow: 'wrap', theme: okPierreTheme() });
}
