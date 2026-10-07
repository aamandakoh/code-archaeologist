import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Timeline } from './types.js';

/** Bump when the Timeline shape changes so old cache entries are ignored. */
const CACHE_VERSION = 1;

export type CacheKey = { root: string; file: string; range: [number, number]; head: string };

/**
 * Timelines on disk, keyed by repo, file, line range and HEAD. A new commit changes
 * HEAD and so misses the cache, which is what we want.
 */
export class TimelineCache {
  constructor(private readonly dir: string) {}

  private pathFor(key: CacheKey): string {
    const id = createHash('sha256')
      .update(JSON.stringify([CACHE_VERSION, key.root, key.file, key.range, key.head]))
      .digest('hex')
      .slice(0, 32);
    return path.join(this.dir, `${id}.json`);
  }

  async get(key: CacheKey): Promise<Timeline | undefined> {
    try {
      return JSON.parse(await readFile(this.pathFor(key), 'utf8')) as Timeline;
    } catch {
      return undefined;
    }
  }

  async set(key: CacheKey, timeline: Timeline): Promise<void> {
    const target = this.pathFor(key);
    await mkdir(this.dir, { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(timeline));
    await rename(temp, target);
  }
}
