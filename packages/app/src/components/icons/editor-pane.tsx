import type { SVGProps } from 'react';

export function EditorPaneIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...props}
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
      <path d="M12.5 9.5h5M12.5 13h3.2" />
    </svg>
  );
}

export function PaneLayoutIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...props}
    >
      <rect x="3" y="4.5" width="8" height="15" rx="1.6" />
      <rect x="13" y="4.5" width="8" height="7" rx="1.6" />
      <rect x="13" y="13.5" width="8" height="6" rx="1.6" />
    </svg>
  );
}
