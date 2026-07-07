'use client';

import {
  InkeepChatButton,
  InkeepModalSearchAndChat,
  type InkeepModalSearchAndChatProps,
} from '@inkeep/cxkit-react';
import type { SharedProps } from 'fumadocs-ui/components/dialog/search';
import { usePathname } from 'next/navigation';
import type { FC } from 'react';
import { GITHUB_URL, SITE_URL } from '@/lib/site';

const apiKey = process.env.NEXT_PUBLIC_INKEEP_API_KEY;

if (!apiKey) {
  console.warn('NEXT_PUBLIC_INKEEP_API_KEY not configured.');
}

const InkeepSearchAndChat: FC<SharedProps> = ({ open, onOpenChange }) => {
  const pathname = usePathname();

  if (!apiKey) {
    return null;
  }
  const url = `${SITE_URL}${pathname}`;

  const config: InkeepModalSearchAndChatProps = {
    baseSettings: {
      apiKey,
      primaryBrandColor: '#D5E5FF',
      organizationDisplayName: 'OpenKnowledge',
      colorMode: {
        sync: {
          target: document.documentElement,
          attributes: ['class'],
          isDarkMode: (attrs) => attrs.class?.split(/\s+/).includes('dark') ?? false,
        },
      },
      theme: {
        styles: [
          {
            key: 'chat-button',
            type: 'style',
            value: `
              .ikp-chat-button__container { z-index: var(--ikp-z-index-overlay); }
              [data-theme="light"] .ikp-chat-button__button {
                background-color: #D5E5FF !important;
                border: 1px solid #69A3FF !important;
                color: #231F20 !important;
                backdrop-filter: blur(10px) !important;
                -webkit-backdrop-filter: blur(10px) !important;
                box-shadow: 5px 6px 18px rgba(157, 194, 255, 0.20), 0 8px 32px rgba(0, 0, 0, 0.08) !important;
                transition: box-shadow 0.2s ease, background-color 0.2s ease, transform 0.2s ease !important;
              }
              [data-theme="light"] .ikp-chat-button__text { color: #231F20 !important; }
              [data-theme="light"] .ikp-chat-button__button:hover {
                background-color: #C9DBFF !important;
                border-color: #69A3FF !important;
                box-shadow: 6px 8px 22px rgba(157, 194, 255, 0.24), 0 10px 36px rgba(0, 0, 0, 0.10) !important;
                transform: translateY(-1px);
              }
              [data-theme="light"] .ikp-chat-button__button:focus-visible {
                box-shadow: 0 0 0 2px #FFFFFF, 0 0 0 4px #69A3FF !important;
              }`,
          },
        ],
      },
      // transformSource: (source) => {
      //   const tabs = source.tabs || [];
      //   if (source.url.includes('openknowledge.ai/docs')) {
      //     tabs.push('Docs');
      //   }
      //   return {
      //     ...source,
      //     tabs,
      //   };
      // },
    },
    aiChatSettings: {
      prompts: [`The user is currently viewing page ${url}.`],
      aiAssistantAvatar: '/ok-logo.png',
      exampleQuestions: [
        'How do I get started with OpenKnowledge?',
        'How do I connect OpenKnowledge to Claude Code, Cursor, or Codex?',
        'How do I share my knowledge base with my team?',
      ],
      getHelpOptions: [
        {
          name: 'GitHub',
          isPinnedToToolbar: true,
          icon: { builtIn: 'FaGithub' },
          action: {
            type: 'open_link',
            url: GITHUB_URL,
          },
        },
      ],
    },
    // searchSettings: {
    //   tabs: [['Docs', { isAlwaysVisible: true }], ['All', { isAlwaysVisible: true }], 'GitHub'],
    // },
  };

  return (
    <>
      <InkeepChatButton {...config} />
      <InkeepModalSearchAndChat
        {...config}
        modalSettings={{
          // disable default cmd+k behavior, it's handled by fumadocs
          shortcutKey: null,
          isOpen: open,
          onOpenChange,
        }}
      />
    </>
  );
};

export default InkeepSearchAndChat;
