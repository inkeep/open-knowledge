import { ArrowRight } from 'lucide-react';
import Image from 'next/image';

type CtaButtonProps = {
  href: string;
  label: string;
  external?: boolean;
};

export function CtaButton({ href, label, external = true }: CtaButtonProps) {
  return (
    <a
      href={href}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      className="ok-overview not-prose group my-4 inline-flex items-center gap-2.5 rounded-[10px] border border-fd-border bg-fd-card py-2.5 pr-4 pl-3.5 text-[14.5px] font-semibold text-fd-foreground no-underline shadow-sm transition hover:-translate-y-px hover:border-[var(--ok-accent)]"
    >
      <Image src="/ok-logo.png" alt="" width={40} height={40} className="size-5 shrink-0" />
      {label}
      <ArrowRight
        className="size-4 shrink-0 text-[var(--ok-accent)] transition-transform group-hover:translate-x-0.5"
        aria-hidden="true"
      />
    </a>
  );
}
