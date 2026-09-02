export function SkillDestinationList({ paths }: { paths: readonly string[] }) {
  return (
    <ul className="flex flex-col gap-0.5" data-testid="skill-destination-list">
      {paths.map((path) => (
        <li key={path}>
          <code className="break-all text-xs text-muted-foreground">{path}</code>
        </li>
      ))}
    </ul>
  );
}
