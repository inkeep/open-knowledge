/**
 * Fixture for `no-raw-route-hash-construction`.
 *
 * 5 positives, then the negatives the rule must leave alone. The negatives
 * carry the weight here: the guard this replaced was a hand-rolled lexer that
 * went blind after a regex literal, so a comment and a string spelling the
 * offending shape are pinned explicitly.
 *
 * Comment spelling the shape, which must NOT fire: `#/${docName}`
 */
declare const docName: string;
declare const folderPath: string;
declare const BASE: string;
declare const hash: string;

// POSITIVE 1 — interpolation directly onto the prefix.
export const p1 = `#/${docName}`;

// POSITIVE 2 — single-quoted concatenation.
export const p2 = '#/' + docName;

// POSITIVE 3 — double-quoted concatenation.
export const p3 = "#/" + folderPath;

// POSITIVE 4 — the prefix reached later in a template.
export const p4 = `${BASE}#/${docName}`;

// POSITIVE 5 — inside a JSX attribute, after a regex literal and a JSX
// apostrophe, both of which desynchronised the lexer this replaced.
const escaped = folderPath.replace(/"/g, '&quot;');
export function Row(): JSX.Element {
  return (
    <a href={`#/${docName}`} title={escaped}>
      Open an agent's page
    </a>
  );
}

// NEGATIVE — reading a hash is a comparison, not a construction.
export const n1 = hash.startsWith('#/');
export const n2 = hash === '#/';

// NEGATIVE — the bare prefix, the content-root sentinel every folder builder
// returns for the root.
export const n3 = '#/';
export const n4 = `#/`;

// NEGATIVE — a string that merely contains the prefix, not joined to a name.
export const n5 = 'navigate to #/ for the root';

// NEGATIVE — a different prefix that happens to end in a slash.
export const n6 = `#!/${docName}`;
