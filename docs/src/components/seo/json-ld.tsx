import type { Thing, WithContext } from 'schema-dts';

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
