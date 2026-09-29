/* biome-ignore-all lint/suspicious/noUndeclaredEnvVars: GitHub Actions invokes this entrypoint outside Turbo. */
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  deriveChannel,
  realPublishedReleaseTags,
  requirePublishedRelease,
  sortReleaseTagsAscending,
} from './published-release-tags.mjs';

export function resolveWriteBackTarget({ requestedTag, channel, publishedTags }) {
  if (!['stable', 'beta'].includes(channel)) throw new Error('Unknown writeback channel');
  const matches = (tag) => deriveChannel(tag) === channel;
  if (requestedTag) {
    if (!matches(requestedTag))
      throw new Error(`Release tag ${requestedTag} does not match writeback channel ${channel}`);
    requirePublishedRelease(requestedTag, publishedTags);
    return requestedTag;
  }
  return sortReleaseTagsAscending(publishedTags).filter(matches).at(-1) ?? null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const channel = process.env.WRITE_BACK_CHANNEL;
    const tag = resolveWriteBackTarget({
      requestedTag: process.env.RELEASE_TAG,
      channel,
      publishedTags: realPublishedReleaseTags(),
    });
    appendFileSync(process.env.GITHUB_OUTPUT, `channel=${tag ? channel : 'none'}\n`);
    if (tag) appendFileSync(process.env.GITHUB_OUTPUT, `release_tag=${tag}\n`);
    console.log(
      tag ? `Reconciling published ${channel} through ${tag}` : `No published ${channel} release`,
    );
  } catch (error) {
    console.error(
      `::error::write-back-target: tag=${JSON.stringify(process.env.RELEASE_TAG)}, channel=${JSON.stringify(process.env.WRITE_BACK_CHANNEL)}: ${error.message}`,
    );
    process.exitCode = 1;
  }
}
