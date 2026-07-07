import type { SVGProps } from 'react';

// OpenClaw brand mark: a smooth vector lobster, flattened to a single `currentColor`
// silhouette so it tracks the sidebar text color and brightens on hover like every
// other brand icon. Antennae are currentColor strokes; the two eyes are punched out
// via a mask so the mark reads as a creature instead of a solid blob.
export function OpenClawIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      role="img"
      aria-label="OpenClaw icon"
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      fill="none"
      viewBox="0 0 120 120"
      {...props}
    >
      <title>OpenClaw icon</title>
      <mask id="openclaw-eyes" maskUnits="userSpaceOnUse" x={0} y={0} width={120} height={120}>
        <rect width={120} height={120} fill="white" />
        <circle cx={45} cy={35} r={6} fill="black" />
        <circle cx={75} cy={35} r={6} fill="black" />
      </mask>
      <g fill="currentColor" mask="url(#openclaw-eyes)">
        {/* body */}
        <path d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z" />
        {/* left claw */}
        <path d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z" />
        {/* right claw */}
        <path d="M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z" />
      </g>
      {/* antennae */}
      <path
        d="M45 15 Q35 5 30 8"
        fill="none"
        stroke="currentColor"
        strokeWidth={3}
        strokeLinecap="round"
      />
      <path
        d="M75 15 Q85 5 90 8"
        fill="none"
        stroke="currentColor"
        strokeWidth={3}
        strokeLinecap="round"
      />
    </svg>
  );
}
