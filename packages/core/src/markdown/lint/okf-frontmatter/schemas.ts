// file-level form is deliberate: the sibling `biome-ignore` must sit on the line
// oxlint-disable unicorn/no-thenable

export const OKF_REQUIRED_SCHEMA: Record<string, unknown> = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'OKF v0.2 — required frontmatter',
  description:
    'The OKF v0.2 conformance floor. A bundle is conformant when every non-reserved .md file contains a parseable YAML frontmatter block whose `type` is non-empty. This schema is the whole of that floor: a concept carrying only `type` is fully conformant. Section numbers cite OKF v0.2: https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/ad30107c31c06aec8a7d5636e0d1058118604e6f/SPEC.md#11-conformance',
  type: 'object',
  required: ['type'],
  properties: {
    type: {
      type: 'string',
      pattern: '\\S',
      description:
        'REQUIRED, and the only always-required key in OKF. A short string identifying the kind of concept; consumers use it for routing, filtering, and presentation. Type values are not registered centrally — pick something descriptive and self-explanatory (`BigQuery Table`, `BigQuery Dataset`, `API Endpoint`, `Metric`, `Playbook`, `Reference`, `Attested Computation`). Consumers must tolerate unknown types, typically by treating them as generic concepts. The `\\S` pattern is what makes §11 rule 2 mean what it says, and it replaces a `minLength` rather than joining one: a length check alone accepts a whitespace-only value that no consumer can route on, and having both would report one mistake twice. OKF v0.2 §4.1, §11.',
    },
  },
};

export const OKF_RECOMMENDED_SCHEMA: Record<string, unknown> = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'OKF v0.2 — recommended frontmatter',
  description:
    'Shapes for the OKF v0.2 recommended keys. Every key here is optional, and nothing is constrained beyond the shape OKF states: declaring a key pins its YAML type when present (so `tags` written as a comma-separated string warns) and advertises it to agents at read time. Section numbers cite OKF v0.2: https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/ad30107c31c06aec8a7d5636e0d1058118604e6f/SPEC.md#41-frontmatter',
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description:
        'Human-readable display name. If omitted, consumers MAY derive a title from the filename. OKF v0.2 §4.1.',
    },
    description: {
      type: 'string',
      description:
        'A single sentence summarizing the concept. Used by `index.md` generators, search snippets, and previews. OKF v0.2 §4.1.',
    },
    resource: {
      type: 'string',
      format: 'uri-reference',
      description:
        'A URI that uniquely identifies the underlying asset the concept describes. Absent for concepts that describe abstract ideas rather than physical resources. Path-valued: an absolute URL, a bundle-relative path beginning with `/`, or an ordinary relative path — hence `uri-reference`, not `uri`, which would reject `/tables/customers.md`. OKF v0.2 §4.1, §6.2.',
    },
    tags: {
      type: 'array',
      items: {
        type: 'string',
      },
      description:
        'A YAML list of short strings for cross-cutting categorization. Tags stay a first-class concept through this field; OKF specifies no separate per-tag file format, so a consumer that wants a tag-browsing view synthesizes one by scanning frontmatter. OKF v0.2 §3.1, §4.1.',
    },
    timestamp: {
      description:
        'LEGACY (OKF v0.1), superseded by `generated.at` in v0.2 — one of the two deliberate breaking changes. Consumers MAY fall back to it when `generated` is absent; new documents SHOULD write `generated: { by, at }` instead. Documented here so agents are told what it is and what replaced it, but deliberately left unconstrained: v0.2 does not define it as a producer field, so validating its shape would be a rule OKF no longer has. OKF v0.2 §5.2, §13.1.',
    },
  },
};

export const OKF_PROVENANCE_SCHEMA: Record<string, unknown> = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'OKF v0.2 — provenance, trust, and lifecycle frontmatter',
  description:
    'The optional OKF v0.2 families that make "where did this come from", "how much should I trust it", and "is it still current" answerable from frontmatter alone. Every key is optional, and absence carries meaning rather than being an error: a concept with no `verified` is unverified, and a consumer must not reject it. Only `sources[].resource` and `generated.by` are required-when-their-parent-is-present, because those are the two fields OKF marks REQUIRED in this family; every other field is described but not mandated, so nothing else is enforced. Section numbers cite OKF v0.2: https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/ad30107c31c06aec8a7d5636e0d1058118604e6f/SPEC.md#5-provenance-trust-and-lifecycle',
  type: 'object',
  properties: {
    sources: {
      type: 'array',
      description:
        "The materials this concept derives from, external or internal to the bundle. Lineage is expressed through links rather than a dedicated field: when an entry's `resource` points at another OKF concept, the derivation edge already exists in the bundle graph, so a consumer may recurse into that source's own `sources`. OKF v0.2 §5.1.",
      items: {
        type: 'object',
        required: ['resource'],
        properties: {
          resource: {
            type: 'string',
            description:
              'REQUIRED within an entry. Either a concrete artifact a consumer can follow (an absolute URL, a bundle-relative path, or a path into a `references/` subdirectory) or a population or scope descriptor it cannot, for example `all queries in BigQuery project X`. Deliberately NOT format-constrained: a scope descriptor is prose, so a `uri-reference` check here would warn on conformant documents. OKF v0.2 §5.1, §6.2, §6.3.',
          },
          id: {
            type: 'string',
            description:
              'Optional. A stable key used to attribute individual claims: a markdown footnote whose label is this id (`[^ga4-schema]`) attributes the claim it follows. SHOULD be present when the body cites the source. Keyed rather than positional because agents constantly rewrite these documents — a positional index misattributes silently the moment the list is reordered. OKF v0.2 §5.1.',
          },
          title: {
            type: 'string',
            description: 'Optional. Human-readable label for the source. OKF v0.2 §5.1.',
          },
          author: {
            type: 'string',
            description:
              'Optional credibility signal — an authority signal: who or what produced the source. OKF describes this as following the actor convention (§7), but its own examples use a `team:<id>` prefix that the three §7 forms do not cover, so no pattern is enforced. OKF v0.2 §5.1, §7.',
          },
          usage_count: {
            type: 'integer',
            description:
              "Optional credibility signal — an adoption and liveness signal: how often `resource` was exercised (dashboard views, query executions, page reads) over `usage_window`. For a single artifact it is that artifact's own exercise count; for a scope descriptor it is the number of exercises within the scope that touch the concept. Coarse by design: comparable at the alive-versus-dead and order-of-magnitude level and against a source's own history, but not a precise cross-kind ranking. Read as liveness and trend, not as a score. OKF v0.2 §5.1.",
          },
          last_modified: {
            type: 'string',
            format: 'date-time',
            description:
              'Optional credibility signal — a recency signal: when the source itself last changed, as an ISO 8601 datetime with an explicit UTC offset (`2026-06-15T00:00:00Z`). Distinct from `generated.at`, which records when the concept was written. OKF v0.2 §5, §5.1.',
          },
          usage_window: {
            type: 'object',
            description:
              'Optional per-entry override of the `usage_window` written as a sibling of `sources`. OKF v0.2 §5.1.',
            properties: {
              from: {
                type: 'string',
                format: 'date-time',
                description:
                  "Start of the window framing this entry's `usage_count`, as an ISO 8601 datetime with an explicit UTC offset (`2026-06-01T00:00:00Z`). OKF v0.2 §5, §5.1.",
              },
              to: {
                type: 'string',
                format: 'date-time',
                description:
                  "End of the window framing this entry's `usage_count`, as an ISO 8601 datetime with an explicit UTC offset (`2026-06-30T00:00:00Z`). OKF v0.2 §5, §5.1.",
              },
            },
          },
        },
      },
    },
    usage_window: {
      type: 'object',
      description:
        'Written once as a sibling of `sources`, this frames every `usage_count` in the list with a `{ from, to }` range. A single entry may carry its own `usage_window` to override it. OKF v0.2 §5, §5.1.',
      properties: {
        from: {
          type: 'string',
          format: 'date-time',
          description:
            'Start of the shared usage window, as an ISO 8601 datetime with an explicit UTC offset (`2026-06-01T00:00:00Z`). OKF v0.2 §5, §5.1.',
        },
        to: {
          type: 'string',
          format: 'date-time',
          description:
            'End of the shared usage window, as an ISO 8601 datetime with an explicit UTC offset (`2026-06-30T00:00:00Z`). OKF v0.2 §5, §5.1.',
        },
      },
    },
    generated: {
      type: 'object',
      required: ['by'],
      description:
        'How the current content was produced. Kept distinct from `verified` because who wrote a concept need not be who confirmed it. OKF v0.2 §5.2.',
      properties: {
        by: {
          type: 'string',
          description:
            'REQUIRED within `generated`. An actor in the OKF convention: `<producer>/<version>` for agents and tools (`reference_agent/gemini-2.5-pro`), `human:<id>` for a person (`human:ahormati`), or `process:<id>` for an automated process (`process:finance-nightly`). Consumers that classify trust key off the `human:` prefix, so producers MUST use it for hand-authored or human-confirmed content — a rule about which form to pick for which content, which frontmatter alone cannot check, so the three forms are documented here rather than enforced by a pattern. OKF v0.2 §5.2, §7.',
        },
        at: {
          type: 'string',
          format: 'date-time',
          description:
            "An ISO 8601 datetime with an explicit UTC offset (`2026-06-30T14:00:00Z`) marking the content's last meaningful change. Consumers use it to tell a recent edit from a stale fact. Supersedes v0.1's top-level `timestamp`. OKF v0.2 §5, §5.2, §13.1.",
        },
      },
    },
    verified: {
      description:
        'Who or what has confirmed the content against its sources or `resource` — a list of verification events. Multiple entries capture independent checks, for example a human sign-off plus a nightly process; "how recently" is the latest `at`. Independent of `generated.at`: content can change without re-confirmation, and facts can be re-confirmed without regeneration. A single verifier MAY be written as one bare `{ by, at }` mapping without the list dash, and consumers MUST treat that as a one-element list — hence the two accepted shapes here. Absence means unverified, which is a valid state, never a rejection. OKF v0.2 §5.2, §5.3, §11.',
      anyOf: [
        {
          type: 'object',
          description: 'The bare single-verifier mapping form. OKF v0.2 §5.2.',
          properties: {
            by: {
              type: 'string',
              description:
                'The verifying actor: `<producer>/<version>`, `human:<id>`, or `process:<id>`. A `human:` verifier is what raises the trust tier to human-reviewed; non-human verifiers alone yield machine-confirmed. OKF v0.2 §5.2, §5.3, §7.',
            },
            at: {
              type: 'string',
              format: 'date-time',
              description:
                'An ISO 8601 datetime with an explicit UTC offset (`2026-07-01T09:00:00Z`) recording when the verification event happened. OKF v0.2 §5, §5.2.',
            },
          },
        },
        {
          type: 'array',
          description:
            'The list form: one entry per independent verification event. OKF v0.2 §5.2.',
          items: {
            type: 'object',
            properties: {
              by: {
                type: 'string',
                description:
                  'The verifying actor: `<producer>/<version>`, `human:<id>`, or `process:<id>`. A `human:` verifier is what raises the trust tier to human-reviewed; non-human verifiers alone yield machine-confirmed. OKF v0.2 §5.2, §5.3, §7.',
              },
              at: {
                type: 'string',
                format: 'date-time',
                description:
                  'An ISO 8601 datetime with an explicit UTC offset (`2026-07-01T09:00:00Z`) recording when the verification event happened. OKF v0.2 §5, §5.2.',
              },
            },
          },
        },
      ],
    },
    status: {
      enum: ['draft', 'stable', 'deprecated'],
      description:
        "Lifecycle state. `draft` = not yet reviewed, possibly incomplete. `stable` = ready for consumption. `deprecated` = kept for links and history, no longer current. Absent means `stable`, so the key is only worth writing to say draft or deprecated. These three values are the whole set OKF defines, which is why this is the pack's only enum. OKF v0.2 §5.4.",
    },
    stale_after: {
      type: 'string',
      format: 'date-time',
      description:
        'An absolute instant, an ISO 8601 datetime with an explicit UTC offset (`2026-12-31T00:00:00Z`): the concept is stale when `now >= stale_after`. Absolute rather than a relative TTL so staleness stays a plain comparison with no reference to when the concept was read. An instant in the past is a freshness signal for consumers, not a violation. OKF v0.2 §5, §5.5, §10.5.',
    },
  },
};

export const OKF_ATTESTED_COMPUTATION_SCHEMA: Record<string, unknown> = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'OKF v0.2 — Attested Computation frontmatter',
  description:
    'Shapes for the OKF v0.2 computation keys, which turn a concept into a sanctioned way to compute a value so a consumer can confirm the agent ran the blessed computation instead of improvising its own. Provenance answers "where did this claim come from"; attestation answers "was this number produced the way we said it must be". This file also carries the one value-shaped rule in the pack: `runtime` is the single key OKF marks REQUIRED here, and only when `type` is `Attested Computation`. Ordinary concepts never match that condition and are unaffected, and no other key in the family is mandated. OKF records the computation and the means to check it and executes nothing itself; receipts and verdicts are runtime artifacts that are never stored in the bundle. Section numbers cite OKF v0.2: https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/ad30107c31c06aec8a7d5636e0d1058118604e6f/SPEC.md#10-attested-computations-concept',
  type: 'object',
  if: {
    required: ['type'],
    properties: {
      type: {
        const: 'Attested Computation',
        description:
          'The condition, not a constraint: everything in `then` applies only to documents whose `type` is exactly `Attested Computation`. An ordinary concept never matches, so nothing in this schema is ever asked of it. `type` is also required inside the condition so a document with no type at all fails the conformance floor once, rather than also being told it is missing a `runtime` for a type it never claimed.',
      },
    },
  },
  // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional, not a thenable
  then: {
    required: ['runtime'],
  },
  properties: {
    runtime: {
      type: 'string',
      description:
        'REQUIRED for `type: Attested Computation`. The single field that says how to run the computation, and therefore how the executor and attester interpret it and what `parameters` mean — a parameter is a SQL bind variable, a dbt var, or a Python argument depending on the runtime. Keeping `runtime` and `parameters` in one frontmatter is what makes the binding semantics self-evident. Example values: `bigquery`, `postgres`, `dbt`, `python`, `Looker`. Not a closed set, so no enum. OKF v0.2 §10.1, §10.2.',
    },
    parameters: {
      type: 'array',
      description:
        'The typed, named holes the agent may fill. An agent MAY only supply values for these parameters; it MUST NOT author or edit the computation. That parameter-only surface is what makes "did the sanctioned thing run" a mechanical comparison rather than a judgement call. OKF v0.2 §10.2, §10.3.',
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              "The parameter name the computation binds, for example `year` bound as `@year` in BigQuery SQL or `{{ var('year') }}` in dbt. OKF v0.2 §10.2, §10.3.",
          },
          type: {
            type: 'string',
            description:
              "The parameter's type, interpreted by `runtime` (`integer`, `string`, and so on). Deliberately not constrained to JSON Schema type names, because the vocabulary belongs to the runtime. OKF v0.2 §10.2.",
          },
          required: {
            type: 'boolean',
            description:
              'Whether the agent must supply a value for this parameter. OKF v0.2 §10.2.',
          },
        },
      },
    },
    computation: {
      type: 'string',
      format: 'uri-reference',
      description:
        "Optional. A path to a file holding the computation, used instead of an inline body fence — best for a long or generated computation, or one already kept as a real file shared with non-OKF tooling. When absent, the body's `# Computation` fence IS the computation. Path-valued: an absolute URL, a bundle-relative path beginning with `/`, or a relative path. OKF v0.2 §6.2, §10.2, §10.3.",
    },
    executor: {
      type: 'object',
      description:
        "How the computation is run. A runner — an agent, or deterministic consumer code — follows `resource`, and the run returns a receipt shaped by `receipt`. Binding the computation with the parameter values into the executable artifact is the consumer's job. OKF v0.2 §10.2, §10.5.",
      properties: {
        resource: {
          type: 'string',
          format: 'uri-reference',
          description:
            'Names the run instructions or code. What sits behind it — a Skill, a script, a container — is a packaging choice; OKF fixes the interface, not the packaging. Conventionally points into a `references/` subdirectory, for example `references/skills/run-on-bq.md`. OKF v0.2 §1, §6.2, §6.3, §10.2.',
        },
        receipt: {
          type: 'array',
          items: {
            type: 'string',
          },
          description:
            'Declares the fields a run must return — the evidence the attester inspects, for example `[job_id, executed_sql, result]` for BigQuery or `[run_id, compiled_sql, result]` for dbt. Because the attester compares the expanded, compiled artifact the receipt carries, a rewritten query, a swapped computation file, or a mutated dependency fails the check. The receipt itself is a runtime artifact and is never stored in the bundle. OKF v0.2 §10.2, §10.3, §10.5.',
        },
      },
    },
    attester: {
      type: 'object',
      description:
        'The deterministic check that inspects a receipt and returns a verdict. Meant to run consumer-side. Distinct from `verified`: `verified` confirms the definition still matches policy and is recorded in the bundle, while attestation confirms a single run produced the value the sanctioned way and is not stored. OKF v0.2 §10.2, §10.6.',
      properties: {
        resource: {
          type: 'string',
          format: 'uri-reference',
          description:
            'Names code — no LLM — that takes a receipt and returns a verdict, independently re-deriving the binding of `computation` with the claimed parameter values to compare against what actually ran. Conventionally points into a `references/` subdirectory, for example `references/attesters/sql-equality.py`. OKF v0.2 §6.2, §6.3, §10.2, §10.3.',
        },
      },
    },
  },
};

export const OKF_RESERVED_INDEX_SCHEMA: Record<string, unknown> = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'OKF v0.2 — index files carry no frontmatter',
  description:
    "`index.md` is a reserved filename at any level of the hierarchy and must not be used for a concept document. Index files contain no frontmatter, with exactly one exception — a bundle-root `index.md` may carry `okf_version` — which the scope carves out with a `!index` exclusion rather than a keyword here. `maxProperties: 0` is the mechanism rather than the boolean schema `false`, because a document with no frontmatter block validates as `{}` and `false` would reject that too, flagging the very documents that are correct. `log.md` is deliberately NOT covered: §9 constrains a log's date headings, ordering, and prose entries but never its frontmatter, and OKF's own reference bundle ships a `log.md` carrying `type` and `title`. Section numbers cite OKF v0.2: https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/ad30107c31c06aec8a7d5636e0d1058118604e6f/SPEC.md#8-index-files",
  type: 'object',
  maxProperties: 0,
};

export const OKF_ROOT_INDEX_SCHEMA: Record<string, unknown> = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'OKF v0.2 — bundle-root index.md',
  description:
    "The bundle-root `index.md` is the only index file OKF permits frontmatter in, and `okf_version` is the key it names there. OKF states the declaration as a MAY, so it is not required here. Nor is the frontmatter closed to other keys: §8 grants the exception for `okf_version` specifically, but §11 tells consumers not to reject a bundle over unknown additional keys, and that ambiguity is resolved in favor of the looser reading. The one thing pinned is the value's shape, because a YAML float is provably lossy where a version string is not. Section numbers cite OKF v0.2: https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/ad30107c31c06aec8a7d5636e0d1058118604e6f/SPEC.md#12-versioning",
  type: 'object',
  properties: {
    okf_version: {
      type: 'string',
      pattern: '^[0-9]+\\.[0-9]+$',
      description:
        'The OKF version this bundle targets, as `<major>.<minor>` — currently `"0.2"`. Quote it: unquoted `0.2` parses as a YAML number, so a consumer comparing version strings sees a float instead, and `0.10` would silently become `0.1`. A minor bump is backward-compatible additions; a major bump may rename required fields or change reserved filenames. Consumers that do not understand the declared version should attempt best-effort consumption rather than refusing the bundle. OKF v0.2 §12.',
    },
  },
};
