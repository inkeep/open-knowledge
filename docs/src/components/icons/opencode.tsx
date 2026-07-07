import type { SVGProps } from 'react';

// OpenCode brand mark (the square "terminal" glyph from opencode.ai), rendered
// monochrome via `currentColor` so it tracks the surrounding text color in both
// themes. The inner block is dropped to a lower opacity to echo the two-tone
// brand mark without baking in the dark background the favicon ships with.
export function OpenCodeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      role="img"
      aria-label="OpenCode icon"
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      fill="none"
      viewBox="0 0 512 512"
      {...props}
    >
      <title>OpenCode icon</title>
      <path
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z"
      />
      <path fill="currentColor" fillOpacity={0.55} d="M320 224V352H192V224H320Z" />
    </svg>
  );
}
