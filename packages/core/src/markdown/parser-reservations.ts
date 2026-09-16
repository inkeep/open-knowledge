import { protectFromMdx, R23_SENTINEL_ESCAPE_SUBSTITUTIONS } from './autolink-void-html-guard.ts';
import { BACKSLASH_GUARD_SUBSTITUTIONS, encodeBackslashEscapes } from './backslash-escape-guard.ts';
import { ENTITY_REF_GUARD_SUBSTITUTIONS, encodeEntityRefs } from './entity-ref-guard.ts';
import { TYPED_WS_REF_PUA } from './to-markdown-handlers.ts';

type ParserMutationSource =
  | {
      mode: 'protecting';
      protect: (source: string) => string;
      reservations: ReadonlyArray<{ to: string }>;
    }
  | {
      mode: 'serializer-only';
      protect?: never;
      reservations: ReadonlyArray<{ to: string }>;
    };

export const PARSER_MUTATION_SOURCES: readonly ParserMutationSource[] = [
  {
    mode: 'protecting',
    protect: encodeBackslashEscapes,
    reservations: BACKSLASH_GUARD_SUBSTITUTIONS,
  },
  {
    mode: 'protecting',
    protect: protectFromMdx,
    reservations: R23_SENTINEL_ESCAPE_SUBSTITUTIONS,
  },
  {
    mode: 'protecting',
    protect: encodeEntityRefs,
    reservations: ENTITY_REF_GUARD_SUBSTITUTIONS,
  },
  {
    mode: 'serializer-only',
    reservations: [{ to: TYPED_WS_REF_PUA }],
  },
];

const MUTATING_PARSER_RESERVATIONS: ReadonlySet<string> = new Set(
  PARSER_MUTATION_SOURCES.flatMap(({ reservations }) => reservations.map(({ to }) => to)),
);

function protectWithMutationSource(
  protectedSource: string,
  mutationSource: ParserMutationSource,
): string {
  switch (mutationSource.mode) {
    case 'protecting':
      return mutationSource.protect(protectedSource);
    case 'serializer-only':
      return protectedSource;
  }
}

export function protectParserSource(source: string): string {
  return PARSER_MUTATION_SOURCES.reduce(protectWithMutationSource, source);
}

export function isMutatingParserReservation(value: string): boolean {
  return MUTATING_PARSER_RESERVATIONS.has(value);
}
