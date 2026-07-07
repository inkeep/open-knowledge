'use client';

import { ArrowDown, ArrowRight, ChevronsDown, ChevronsRight } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

type MarketingButtonVariant =
  | 'primary'
  | 'primary-light'
  | 'secondary'
  | 'tertiary'
  | 'outline'
  | 'minimal'
  | 'icon';

type MarketingButtonSize = 'sm' | 'md' | 'lg';
type MarketingButtonIconStyle = 'plain' | 'circle' | 'chevrons';
type MarketingButtonIconDirection = 'right' | 'down';

interface MarketingButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  children: React.ReactNode;
  variant?: MarketingButtonVariant;
  size?: MarketingButtonSize;
  showIcon?: boolean;
  icon?: React.ReactNode;
  iconStyle?: MarketingButtonIconStyle;
  iconDirection?: MarketingButtonIconDirection;
  onClick?: (event: React.MouseEvent<HTMLButtonElement | HTMLAnchorElement>) => void;
  disabled?: boolean;
  className?: string;
  href?: string;
  target?: string;
  rel?: string;
  download?: boolean | string;
}

const baseClasses = cn(
  // Bare `transition` (not `transition-all`) covers Tailwind's curated set —
  // colors, opacity, box-shadow, transform, filter — without animating
  // layout-triggering properties like width/height.
  'flex items-center gap-2 transition duration-200 ease-in-out',
  'outline-none focus-visible:ring-2 focus-visible:ring-slide-accent focus-visible:ring-offset-2',
  'disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer',
);

const getRadiusClasses = (variant: MarketingButtonVariant) => {
  if (variant === 'outline') return 'rounded';
  if (variant === 'tertiary') return 'rounded-[10px]';
  if (variant === 'icon') return 'rounded-full';
  if (variant === 'secondary') return 'rounded-[43.2px]';
  return 'rounded-full';
};

const getDimensionClasses = (variant: MarketingButtonVariant, size: MarketingButtonSize) => {
  if (variant === 'minimal') return 'h-auto px-0';
  if (variant === 'outline') return 'py-[13px] px-5';
  if (variant === 'tertiary') return size === 'sm' ? 'py-1.5 px-2.5' : 'py-[13px] px-[14px]';
  if (variant === 'icon') return 'p-2';
  if (variant === 'secondary') return 'h-10 px-[22px] py-[14px]';
  if (size === 'sm') return 'h-[36px] px-[22px] py-2.5';
  if (size === 'lg') return 'h-14 px-5 py-[14px]';
  return 'h-12 px-[18px] py-[14px]';
};

const getTextClasses = (variant: MarketingButtonVariant, size: MarketingButtonSize) => {
  const sizeTextClass =
    size === 'sm' ? 'text-sm' : size === 'lg' ? 'text-base sm:text-lg' : 'text-sm sm:text-base';

  if (variant === 'primary') {
    return `text-white ${sizeTextClass} font-medium leading-[115%] tracking-[-0.64px] uppercase`;
  }
  if (variant === 'primary-light') {
    return `text-blue-dark ${sizeTextClass} font-medium leading-[115%] tracking-[-0.64px] uppercase`;
  }
  if (variant === 'secondary') {
    return 'text-night-sky-800 text-sm font-medium leading-none uppercase';
  }
  if (variant === 'tertiary') {
    const tertiaryTextSize = size === 'sm' ? 'text-xs' : 'text-base';
    return `text-night-sky ${tertiaryTextSize} font-normal leading-[115%] tracking-[-0.64px] uppercase`;
  }
  if (variant === 'outline') {
    return 'text-azure-blue text-sm sm:text-base font-normal leading-[115%] tracking-normal';
  }
  if (variant === 'minimal') {
    return 'text-night-sky text-base sm:text-xl font-normal leading-[115%] tracking-[-0.8px]';
  }
  if (variant === 'icon') {
    return 'text-night-sky text-sm font-medium leading-[115%] tracking-[-0.64px]';
  }
  return 'text-night-sky text-sm sm:text-base font-normal leading-normal tracking-normal';
};

const variantClasses: Record<MarketingButtonVariant, string> = {
  primary:
    'bg-azure-blue hover:bg-blue-dark hover:shadow-lg hover:-translate-y-0.5 active:scale-[0.98]',
  'primary-light':
    'bg-crystal-blue hover:bg-blue-dark hover:text-white hover:shadow-lg hover:-translate-y-0.5',
  secondary: 'bg-golden-sun-100 border border-morning-mist-700 hover:bg-golden-sun-200',
  tertiary:
    'bg-white-cream border border-night-sky hover:bg-crystal-blue hover:border-azure-blue hover:text-blue-dark',
  outline: 'bg-transparent border border-azure-blue hover:bg-azure-blue hover:text-white',
  minimal:
    'relative bg-transparent border-none hover:text-azure-blue underline-offset-4 hover:underline',
  icon: 'bg-transparent hover:opacity-80 hover:shadow-md',
};

const circleArrowSize: Record<MarketingButtonSize, string> = {
  sm: 'w-6 h-6',
  md: 'w-8 h-8',
  lg: 'w-9 h-9',
};

const circleArrowIconSize: Record<MarketingButtonSize, string> = {
  sm: 'size-3',
  md: 'size-4',
  lg: 'size-[18px]',
};

const chevronsCircleSize: Record<MarketingButtonSize, string> = {
  sm: 'w-7 h-7',
  md: 'w-[34px] h-[34px]',
  lg: 'w-10 h-10',
};

const chevronsIconSize: Record<MarketingButtonSize, string> = {
  sm: 'size-[18px]',
  md: 'size-[22px]',
  lg: 'size-[26px]',
};

const plainArrowSize: Record<MarketingButtonSize, string> = {
  sm: 'size-4',
  md: 'size-5',
  lg: 'size-5',
};

export function MarketingButton({
  children,
  variant = 'primary',
  size = 'md',
  showIcon = false,
  icon,
  iconStyle = 'circle',
  iconDirection = 'right',
  onClick,
  disabled = false,
  className = '',
  type = 'button',
  href,
  target,
  rel,
  download,
  ...props
}: MarketingButtonProps) {
  const handleClick = (e: React.MouseEvent<HTMLButtonElement | HTMLAnchorElement>) => {
    if (!disabled && onClick) onClick(e);
  };

  const handleAnchorClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (disabled) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    handleClick(e);
  };

  // Source: skip the `pr-2.5` icon override for `secondary` so its fixed
  // 22px right padding is preserved.
  const layoutClasses =
    showIcon && variant !== 'minimal' && variant !== 'icon' && variant !== 'secondary'
      ? 'pr-2.5'
      : '';

  const buttonClasses = cn(
    baseClasses,
    getRadiusClasses(variant),
    getDimensionClasses(variant, size),
    getTextClasses(variant, size),
    variantClasses[variant],
    layoutClasses,
    className,
    disabled && 'opacity-60 cursor-not-allowed pointer-events-none',
  );

  const isPrimaryVariant = variant === 'primary' || variant === 'primary-light';
  const ArrowIcon = iconDirection === 'down' ? ArrowDown : ArrowRight;
  const ChevronsIcon = iconDirection === 'down' ? ChevronsDown : ChevronsRight;
  const isFileLink = typeof href === 'string' && href.split('?')[0]?.toLowerCase().endsWith('.pdf');
  // Download/update routes are 302 redirect handlers, not client-navigable
  // pages — render them as a raw <a> so next/link never prefetches them (which
  // would fire the redirect and inflate download counts) or double-fetches on
  // click. Mirrors the raw-<a> pattern in app/d/[encoded]/splash-buttons.tsx.
  const isRedirectRoute =
    typeof href === 'string' && (href.startsWith('/download/') || href.startsWith('/updates/'));
  // An explicit `download` only takes effect on a raw <a> — next/link drops the
  // attribute — so force the raw-anchor path (also avoids prefetching the file).
  const useRawAnchor = isFileLink || isRedirectRoute || typeof download !== 'undefined';
  const computedDownload = typeof download !== 'undefined' ? download : isFileLink ? '' : undefined;

  const buttonContent = (
    <>
      {variant === 'minimal' && showIcon && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-[-1px] left-[-1.5px] z-0 size-2 shrink-0 rounded-xs bg-purple-light"
        />
      )}

      {variant === 'icon' && icon && (
        <span aria-hidden="true" className="shrink-0">
          {icon}
        </span>
      )}

      <span className="relative z-[1] whitespace-nowrap font-mono">{children}</span>

      {showIcon &&
        isPrimaryVariant &&
        (iconStyle === 'circle' ? (
          <span
            aria-hidden="true"
            className={cn(
              'ml-auto flex shrink-0 items-center justify-center rounded-full bg-white',
              circleArrowSize[size],
            )}
          >
            <ArrowIcon
              className={cn(
                circleArrowIconSize[size],
                variant === 'primary' ? 'text-night-sky' : 'text-blue-dark',
              )}
            />
          </span>
        ) : iconStyle === 'chevrons' ? (
          <span
            aria-hidden="true"
            className={cn(
              'ml-auto flex shrink-0 items-center justify-center rounded-full bg-white',
              chevronsCircleSize[size],
            )}
          >
            <ChevronsIcon
              className={cn(
                chevronsIconSize[size],
                variant === 'primary' ? 'text-night-sky' : 'text-blue-dark',
              )}
            />
          </span>
        ) : (
          <ArrowIcon aria-hidden="true" className={cn('ml-auto shrink-0', plainArrowSize[size])} />
        ))}

      {showIcon && (variant === 'secondary' || variant === 'tertiary' || variant === 'outline') && (
        <ArrowIcon
          aria-hidden="true"
          className={cn('ml-auto size-5 shrink-0', variant === 'outline' && 'text-azure-blue')}
        />
      )}
    </>
  );

  if (href) {
    const defaultRel = target === '_blank' ? 'noopener noreferrer' : undefined;
    const finalRel = rel || defaultRel;

    if (useRawAnchor) {
      return (
        <a
          href={href}
          className={buttonClasses}
          target={target}
          rel={finalRel}
          aria-label={props['aria-label']}
          title={props.title}
          onClick={handleAnchorClick}
          download={computedDownload}
          aria-disabled={disabled ? 'true' : undefined}
          tabIndex={disabled ? -1 : undefined}
        >
          {buttonContent}
        </a>
      );
    }

    return (
      <Link
        href={href}
        className={buttonClasses}
        target={target}
        rel={finalRel}
        aria-label={props['aria-label']}
        title={props.title}
        onClick={onClick}
      >
        {buttonContent}
      </Link>
    );
  }

  return (
    <button
      type={type}
      className={buttonClasses}
      onClick={handleClick}
      disabled={disabled}
      {...props}
    >
      {buttonContent}
    </button>
  );
}
