import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Story, Timeline } from './types.js';

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

export type StoryKey = { version: number; model: string; prompt: string };

/** Stories on disk, keyed by the exact prompt and model, so a rerun never calls the model twice. */
export class StoryCache {
  constructor(private readonly dir: string) {}

  private pathFor(key: StoryKey): string {
    const id = createHash('sha256').update(JSON.stringify([key.version, key.model, key.prompt])).digest('hex').slice(0, 32);
    return path.join(this.dir, `${id}.json`);
  }

  async get(key: StoryKey): Promise<Story | undefined> {
    try {
      return JSON.parse(await readFile(this.pathFor(key), 'utf8')) as Story;
    } catch {
      return undefined;
    }
  }

  async set(key: StoryKey, story: Story): Promise<void> {
    const target = this.pathFor(key);
    await mkdir(this.dir, { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(story));
    await rename(temp, target);
  }
}

/**
 * GitHub API responses on disk, keyed by request path. `null` records a 404. Entries older than
 * `maxAgeMs` are refetched, so new review comments show up eventually.
 */
export class GitHubCache {
  constructor(
    private readonly dir: string,
    private readonly maxAgeMs = 7 * 24 * 60 * 60 * 1000,
  ) {}

  private pathFor(route: string): string {
    return path.join(this.dir, `${createHash('sha256').update(route).digest('hex').slice(0, 32)}.json`);
  }

  async get(route: string): Promise<{ data: unknown } | undefined> {
    try {
      const entry = JSON.parse(await readFile(this.pathFor(route), 'utf8')) as { at: number; data: unknown };
      return Date.now() - entry.at <= this.maxAgeMs ? { data: entry.data } : undefined;
    } catch {
      return undefined;
    }
  }

  async set(route: string, data: unknown): Promise<void> {
    const target = this.pathFor(route);
    await mkdir(this.dir, { recursive: true });
    const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(temp, JSON.stringify({ at: Date.now(), data }));
    await rename(temp, target);
  }
}
