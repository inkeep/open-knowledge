import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { OkPackId } from '@/lib/desktop-bridge-types';

export const PACK_BLURBS: Partial<Record<OkPackId, MessageDescriptor>> = {
  'knowledge-base': msg`Turn the things you read into clear, trusted articles. Save a source, figure out what it means, then keep the final version so you can rely on it later.`,
  'software-lifecycle': msg`Keep a written record of how your product gets built. A home for proposing ideas, recording decisions, writing specs, and capturing what you learned after something broke.`,
  'codebase-wiki': msg`Explain how your codebase works so teammates and AI agents can find their way around. Good for documenting the architecture, the main parts, and the questions new contributors always ask.`,
  'plain-notes': msg`A simple place to write, with one file per topic and a daily journal. Pick this if you just want to start writing and let the links between notes build up over time.`,
  okf: msg`A knowledge base that follows Google's Open Knowledge Format, a shared way of organizing what you know. Pick this if you want your notes to work well with other tools that understand the format.`,
  'writing-pipeline': msg`Take a piece of writing from a rough idea to a finished draft to something you're ready to share. Good for blog posts, essays, or anything you want to move through clear stages.`,
  'entity-vault': msg`Keep track of the people and companies you work with and the meetings you have with them. Good for remembering who someone is, how you know them, and what you last talked about.`,
  worldbuilding: msg`Build and keep track of the world behind your story. A home for your characters, places, factions, and the lore that ties them together, so details stay consistent as you write.`,
};
