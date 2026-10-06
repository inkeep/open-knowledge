import {
  asTargetNamespace,
  buildPagesByBasenameIndex,
  buildPagesBySlugIndex,
  parseGlobalSkillBundleDoc,
  toWikiLinkSlug,
  type WikiLinkLookupIndex,
} from '@inkeep/open-knowledge-core';

export function buildProjectWikiLinkLookup(docNames: Iterable<string>): WikiLinkLookupIndex {
  const pages = asTargetNamespace('document', docNames);
  const projectPages = new Set([...pages].filter((page) => !parseGlobalSkillBundleDoc(page)));
  return {
    pages,
    pagesBySlug: buildPagesBySlugIndex(projectPages, toWikiLinkSlug),
    pagesByBasename: buildPagesByBasenameIndex(projectPages, toWikiLinkSlug),
  };
}
