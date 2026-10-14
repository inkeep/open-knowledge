import { type SVGProps, useId } from 'react';

export function OkIcon(props: SVGProps<SVGSVGElement>) {
  const filterId = `ok-shadow-${useId().replace(/:/g, '')}`;
  return (
    <svg
      role="img"
      aria-label="OpenKnowledge icon"
      fill="none"
      height={24}
      width={24}
      viewBox="0 0 78 80"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <title>OpenKnowledge icon</title>
      <g filter={`url(#${filterId})`}>
        <path
          d="M66.8902 16.1017C58.2694 3.86669 46.1739 -0.690239 29.9182 2.17749C21.3995 3.67813 13.4602 9.555 8.67934 17.9009C3.93974 26.1701 2.98514 35.6533 6.05714 43.9166C9.31574 52.6868 16.7168 58.4752 24.2299 63.4231C25.7973 64.4562 26.1351 65.7172 26.3551 68.9896C26.5221 71.4625 26.799 75.6011 30.6842 77.7204C31.8176 78.3372 33.0648 78.6515 34.3946 78.6515C37.0796 78.6515 39.4033 77.3649 40.5189 76.7482C47.1049 73.1046 68.8878 59.7147 72.6453 40.4027C74.3444 31.6679 70.9797 21.9019 66.8922 16.1017H66.8902Z"
          fill="white"
        />
        <path
          d="M37.4214 71.154C28.7888 75.929 36.787 64.0397 27.7458 58.0843C21.6372 54.0616 14.788 49.0568 12.0499 41.6911C6.74463 27.4192 17.5438 10.8473 31.028 8.47262C45.1977 5.97613 54.6946 9.8947 61.6635 19.7844C65.2089 24.8167 67.6013 32.8365 66.3658 39.1828C63.6906 52.9341 49.073 64.7075 37.4214 71.154Z"
          fill="#69A3FF"
        />
        <path
          d="M52.7244 29.2638C53.4665 28.5217 54.6697 28.5217 55.4119 29.2638V29.2638C56.154 30.0059 56.154 31.2091 55.4119 31.9513L49.2589 38.1042L46.5715 35.4167L52.7244 29.2638Z"
          fill="#D5E5FF"
        />
        <path
          d="M55.4119 38.8821C56.154 39.6242 56.154 40.8274 55.4119 41.5696V41.5696C54.6698 42.3117 53.4665 42.3117 52.7244 41.5696L46.5715 35.4166L49.259 32.7292L55.4119 38.8821Z"
          fill="#D5E5FF"
        />
      </g>
      <defs>
        <filter
          id={filterId}
          x="-9.53674e-07"
          y="-0.0799994"
          width="77.3817"
          height="85.8743"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy="2.85714" />
          <feGaussianBlur stdDeviation="2.14286" />
          <feComposite in2="hardAlpha" operator="out" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.1 0" />
          <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_ok" />
          <feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow_ok" result="shape" />
        </filter>
      </defs>
    </svg>
  );
}
