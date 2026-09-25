import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  CacheWarmer,
  DownloadableSentence,
  SectionEnumerator,
  TTSDownloader,
} from '@/services/tts/TTSDownloader';

const sentence = (ordinal: number, text: string): DownloadableSentence => ({
  ordinal,
  label: `0:s${ordinal}`,
  lang: 'en',
  text,
});

describe('TTSDownloader', () => {
  let enumerated: Record<number, DownloadableSentence[] | null>;
  let warmer: CacheWarmer & {
    manifests: { section: number; labels: string[] }[];
    warmed: { section: number; ordinal: number; text: string }[];
    compacts: number;
  };
  let enumerator: SectionEnumerator;
  let warmFails: Set<string>;

  beforeEach(() => {
    enumerated = {};
    warmFails = new Set();
    warmer = {
      manifests: [],
      warmed: [],
      compacts: 0,
      registerSectionManifest(section, labels) {
        this.manifests.push({ section, labels });
      },
      warmSentence: vi.fn().mockImplementation(async (section, ordinal, _lang, text) => {
        warmer.warmed.push({ section, ordinal, text });
        return !warmFails.has(text);
      }),
      compactCache: vi.fn().mockImplementation(async () => {
        warmer.compacts++;
      }),
    };
    enumerator = {
      enumerateSection: vi.fn().mockImplementation(async (i: number) => enumerated[i] ?? null),
    };
  });

  test('synthesizes every sentence of a section in order and compacts once', async () => {
    enumerated[2] = [sentence(0, 'a'), sentence(1, 'b'), sentence(2, 'c')];
    const downloader = new TTSDownloader(enumerator, warmer);
    const progress: string[] = [];
    const result = await downloader.download([2], (p) => progress.push(`${p.done}/${p.total}`));

    expect(warmer.manifests).toEqual([{ section: 2, labels: ['0:s0', '0:s1', '0:s2'] }]);
    expect(warmer.warmed.map((w) => w.text)).toEqual(['a', 'b', 'c']);
    expect(warmer.compacts).toBe(1);
    expect(progress).toEqual(['1/3', '2/3', '3/3']);
    expect(result.completed).toEqual([2]);
  });

  test('processes multiple sections and reports per-section totals', async () => {
    enumerated[0] = [sentence(0, 'a')];
    enumerated[1] = [sentence(0, 'x'), sentence(1, 'y')];
    const downloader = new TTSDownloader(enumerator, warmer);
    const seen: { section: number; total: number }[] = [];
    await downloader.download([0, 1], (p) =>
      seen.push({ section: p.sectionIndex, total: p.total }),
    );
    expect(warmer.compacts).toBe(2);
    expect(seen).toContainEqual({ section: 0, total: 1 });
    expect(seen).toContainEqual({ section: 1, total: 2 });
  });

  test('a section that cannot enumerate is skipped, not fatal', async () => {
    enumerated[0] = null;
    enumerated[1] = [sentence(0, 'x')];
    const downloader = new TTSDownloader(enumerator, warmer);
    const result = await downloader.download([0, 1]);
    expect(result.completed).toEqual([1]);
    expect(result.skipped).toEqual([0]);
  });

  test('records only the sentences that synthesized (a failed one is not recorded)', async () => {
    enumerated[0] = [sentence(0, 'a'), sentence(1, 'bad'), sentence(2, 'c')];
    warmFails.add('bad');
    const downloader = new TTSDownloader(enumerator, warmer);
    const result = await downloader.download([0]);
    // The two good sentences once, and the failed one again on the retry pass.
    expect(warmer.warmed).toHaveLength(4);
    expect(result.synthesized).toBe(2);
    // A section with a failed sentence is reported skipped, not completed: the
    // manifest gap means it has not fully downloaded.
    expect(result.completed).toEqual([]);
    expect(result.skipped).toEqual([0]);
    // A section with a failed sentence is still compacted (the pack simply
    // won't form until the gap fills), so a later retry can complete it.
    expect(warmer.compacts).toBe(1);
  });

  test('an empty section registers an empty manifest and still compacts', async () => {
    enumerated[0] = [];
    const downloader = new TTSDownloader(enumerator, warmer);
    await downloader.download([0]);
    expect(warmer.manifests).toEqual([{ section: 0, labels: [] }]);
    expect(warmer.warmed).toHaveLength(0);
  });

  test('abort stops before the next section and does not compact it', async () => {
    enumerated[0] = [sentence(0, 'a')];
    enumerated[1] = [sentence(0, 'b')];
    const controller = new AbortController();
    warmer.warmSentence = vi.fn().mockImplementation(async (section, ordinal, _l, text) => {
      warmer.warmed.push({ section, ordinal, text });
      controller.abort(); // abort mid-first-section
      return true;
    });
    const downloader = new TTSDownloader(enumerator, warmer);
    const result = await downloader.download([0, 1], undefined, controller.signal);
    expect(warmer.warmed.map((w) => w.section)).toEqual([0]);
    expect(result.completed).not.toContain(1);
    expect(enumerator.enumerateSection).not.toHaveBeenCalledWith(1);
  });

  test('keeps a window of warmSentence calls in flight and commits progress in order', async () => {
    enumerated[0] = [sentence(0, 'a'), sentence(1, 'b'), sentence(2, 'c'), sentence(3, 'd')];
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let started = 0;
    warmer.warmSentence = vi.fn().mockImplementation(async (section, ordinal, _lang, text) => {
      started++;
      if (text === 'a') await first;
      warmer.warmed.push({ section, ordinal, text });
      return true;
    });
    const downloader = new TTSDownloader(enumerator, warmer, 4);
    const progress: string[] = [];
    const pending = downloader.download([0], (p) => progress.push(`${p.done}/${p.total}`));
    await vi.waitFor(() => expect(started).toBe(4));
    expect(progress).toEqual([]);
    releaseFirst();
    const result = await pending;
    expect(warmer.warmed.map((w) => w.text).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(progress).toEqual(['1/4', '2/4', '3/4', '4/4']);
    expect(result.completed).toEqual([0]);
    expect(result.synthesized).toBe(4);
  });

  test('retries a failed sentence once before skipping the section', async () => {
    enumerated[0] = [sentence(0, 'a'), sentence(1, 'bad')];
    const attempts = new Map<string, number>();
    warmer.warmSentence = vi.fn().mockImplementation(async (section, ordinal, _lang, text) => {
      const n = (attempts.get(text) ?? 0) + 1;
      attempts.set(text, n);
      warmer.warmed.push({ section, ordinal, text });
      return text !== 'bad' || n > 1;
    });
    const downloader = new TTSDownloader(enumerator, warmer, 2);
    const result = await downloader.download([0]);
    expect(attempts.get('bad')).toBe(2);
    expect(result.completed).toEqual([0]);
    expect(result.skipped).toEqual([]);
    expect(result.synthesized).toBe(2);
  });

  test('a sentence that fails twice still skips the section', async () => {
    enumerated[0] = [sentence(0, 'bad')];
    warmFails.add('bad');
    const downloader = new TTSDownloader(enumerator, warmer, 1);
    const result = await downloader.download([0]);
    expect(warmer.warmed).toHaveLength(2);
    expect(result.completed).toEqual([]);
    expect(result.skipped).toEqual([0]);
    expect(result.synthesized).toBe(0);
  });
});
