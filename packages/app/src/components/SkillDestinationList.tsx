/**
 * The filesystem destinations a built-in skill install writes to (or an
 * uninstall removes from) — one path per line, rendered verbatim including
 * declared custom roots. Shared by the install/uninstall confirm modal and the
 * first-launch inline expansion so both disclose the same paths the same way.
 * The caller owns the surrounding heading ("Installs to" / "Removes from") so
 * the list stays neutral to direction.
 */
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
