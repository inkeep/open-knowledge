import type { Thing, WithContext } from 'schema-dts';

function safeJsonLdSerialize(value: unknown): string {
  return JSON.stringify(value).replace(/<\/script/gi, '<\\/script');
}

export function JsonLd({ json }: { json: WithContext<Thing> | WithContext<Thing>[] }) {
  return (
    <script
      type="application/ld+json"
      // oxlint-disable-next-line react/no-danger -- JSON-LD requires raw JSON inside a <script> tag; React children would be HTML-escaped and break the JSON. </script>-escape guard above keeps the tag breakout-safe.
      dangerouslySetInnerHTML={{ __html: safeJsonLdSerialize(json) }}
    />
  );
}
