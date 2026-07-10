import type { SVGProps } from 'react';

// Antigravity brand mark, rendered monochrome via `currentColor` so it inherits
// the sidebar text color like every other nav brand icon. A simple geometric
// "upward" glyph (evoking anti-gravity) stands in for the official multi-color
// logo, which OK does not ship. The SVG markup is kept identical to the app-side
// icon at `packages/app/src/components/icons/antigravity.tsx` (the surrounding
// comment is tailored per context, matching the pi.tsx / opencode.tsx pattern).
export function AntigravityIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      role="img"
      aria-label="Antigravity icon"
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      fill="none"
      viewBox="0 0 24 24"
      {...props}
    >
      <title>Antigravity icon</title>
      <path
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2.5a1.5 1.5 0 0 1 1.28.72l8.5 14A1.5 1.5 0 0 1 20.5 19.5h-17a1.5 1.5 0 0 1-1.28-2.28l8.5-14A1.5 1.5 0 0 1 12 2.5Zm0 4.42L5.83 17h12.34L12 6.92Z"
      />
      <path fill="currentColor" d="M12 9.6 15.6 17h-7.2L12 9.6Z" />
    </svg>
  );
}
