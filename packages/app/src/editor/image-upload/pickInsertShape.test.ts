import { describe, expect, test } from 'vitest';
import { pickInsertShape } from './index';

describe('pickInsertShape — emit-dispatch by extension', () => {
  test('image extension emits jsx-img (canonical <img> JSX shape)', () => {
    expect(pickInsertShape('photo.png').kind).toBe('jsx-img');
    expect(pickInsertShape('diagram.svg').kind).toBe('jsx-img');
    expect(pickInsertShape('snap.jpg').kind).toBe('jsx-img');
    expect(pickInsertShape('avatar.webp').kind).toBe('jsx-img');
  });

  test('video extension emits jsx-video (canonical <video> JSX shape)', () => {
    expect(pickInsertShape('clip.mp4').kind).toBe('jsx-video');
    expect(pickInsertShape('reel.webm').kind).toBe('jsx-video');
    expect(pickInsertShape('demo.mov').kind).toBe('jsx-video');
    expect(pickInsertShape('preview.m4v').kind).toBe('jsx-video');
    expect(pickInsertShape('master.mkv').kind).toBe('jsx-video');
  });

  test('audio extension emits jsx-audio (canonical <audio> JSX shape)', () => {
    expect(pickInsertShape('song.mp3').kind).toBe('jsx-audio');
    expect(pickInsertShape('voice.wav').kind).toBe('jsx-audio');
    expect(pickInsertShape('podcast.ogg').kind).toBe('jsx-audio');
    expect(pickInsertShape('clip.m4a').kind).toBe('jsx-audio');
    expect(pickInsertShape('master.flac').kind).toBe('jsx-audio');
    expect(pickInsertShape('jingle.aac').kind).toBe('jsx-audio');
    expect(pickInsertShape('vox.opus').kind).toBe('jsx-audio');
  });

  test('FILE_ATTACHMENT extension emits jsx-file (PDF + office docs + archives + structured-text)', () => {
    expect(pickInsertShape('draft.pdf').kind).toBe('jsx-file');
    expect(pickInsertShape('archive.zip').kind).toBe('jsx-file');
    expect(pickInsertShape('report.docx').kind).toBe('jsx-file');
    expect(pickInsertShape('data.csv').kind).toBe('jsx-file');
    expect(pickInsertShape('budget.xlsx').kind).toBe('jsx-file');
  });

  test('truly-opaque extension (not in any set) emits markdown-link', () => {
    expect(pickInsertShape('mystery.xyz').kind).toBe('markdown-link');
    expect(pickInsertShape('payload.qux').kind).toBe('markdown-link');
  });

  test('extension matching is case-insensitive', () => {
    expect(pickInsertShape('PHOTO.PNG').kind).toBe('jsx-img');
    expect(pickInsertShape('Clip.MP4').kind).toBe('jsx-video');
    expect(pickInsertShape('Song.MP3').kind).toBe('jsx-audio');
    expect(pickInsertShape('DRAFT.PDF').kind).toBe('jsx-file');
    expect(pickInsertShape('Archive.ZIP').kind).toBe('jsx-file');
  });

  describe('markdown files emit wiki-link (link semantic, not embed)', () => {
    test('.md emits wiki-link', () => {
      expect(pickInsertShape('notes.md').kind).toBe('wiki-link');
    });

    test('.mdx emits wiki-link', () => {
      expect(pickInsertShape('notes.mdx').kind).toBe('wiki-link');
    });

    test('extension matching is case-insensitive', () => {
      expect(pickInsertShape('NOTES.MD').kind).toBe('wiki-link');
      expect(pickInsertShape('NOTES.MDX').kind).toBe('wiki-link');
    });
  });

  test('file without extension emits markdown-link', () => {
    expect(pickInsertShape('README').kind).toBe('markdown-link');
  });
});
