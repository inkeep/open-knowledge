import type { Thing, WithContext } from 'schema-dts';

/**
 * Replace any `</script>` sequences in the serialized JSON so a future
 * dynamic schema input (e.g. page title containing literal `</script>`)
 * can't escape the surrounding <script type="application/ld+json"> tag.
 * Current inputs are static literals — this is defense-in-depth.
 */
function safeJsonLdSerialize(value: unknown): string {
  return JSON.stringify(value).replace(/<\/script/gi, '<\\/script');
}

export function JsonLd({ json }: { json: WithContext<Thing> | WithContext<Thing>[] }) {
  return (
    <script
      type="application/ld+json"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD requires raw JSON inside a <script> tag; React children would be HTML-escaped and break the JSON. </script>-escape guard above keeps the tag breakout-safe.
      dangerouslySetInnerHTML={{ __html: safeJsonLdSerialize(json) }}
    />
  );
}
