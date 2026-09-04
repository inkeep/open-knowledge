import type { SVGProps } from 'react';

export function LmStudioIcon(props: SVGProps<SVGSVGElement>) {
  const bars = [
    { x: 1.9, y: 0, w: 15.15 },
    { x: 8.0, y: 4.22, w: 15.15 },
    { x: 4.35, y: 8.44, w: 15.3 },
    { x: 0, y: 12.66, w: 15.15 },
    { x: 4.35, y: 16.88, w: 15.3 },
    { x: 14.1, y: 21.1, w: 9.9 },
  ];
  return (
    <svg
      role="img"
      aria-label="LM Studio icon"
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      fill="currentColor"
      viewBox="0 0 24 24"
      {...props}
    >
      <title>LM Studio icon</title>
      {bars.map((b) => (
        <rect key={b.y} x={b.x} y={b.y} width={b.w} height={2.9} rx={1.45} />
      ))}
    </svg>
  );
}
