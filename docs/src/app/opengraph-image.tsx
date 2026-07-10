import { ImageResponse } from 'next/og';
import {
  BrandCard,
  dmSansFontsArg,
  loadDmSans,
  OG_CONTENT_TYPE,
  OG_RESPONSE_HEADERS,
  OG_SIZE,
} from '@/lib/og-card';
import { SITE_HEADLINE, SITE_NAME } from '@/lib/site';

export const dynamic = 'force-static';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = `${SITE_NAME} — ${SITE_HEADLINE}`;

export default async function OgImage() {
  const fonts = await loadDmSans();
  return new ImageResponse(<BrandCard />, {
    ...OG_SIZE,
    fonts: dmSansFontsArg(fonts),
    headers: OG_RESPONSE_HEADERS,
  });
}
