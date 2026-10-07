# Code Archaeologist

Select some lines in VS Code and ask **"Why is this here?"**. Code Archaeologist plays back
how those lines evolved, commit by commit, so you can see what changed, when and why, with a
cited "safe to change?" verdict pinned at the top.

## Status

| Milestone | What it adds | State |
| --- | --- | --- |
| M0 | Workspaces, build, tests, extension skeleton | Done |
| M1 | `git log -L` trace, noise filter, CLI, raw history panel | Done |
| M2 | AI notes, summary and risk verdict (Gemini) | Done |
| M3 | GitHub PRs, review comments and issues | Next |
| M4 | Time-lapse UI polish | |
| M5 | Demo recording | |

## Layout

```
packages/
  core/       evidence engine: trace, parse, noise filter, AI story, cache. Never imports vscode.
  cli/        `archaeologist trace <file> <start> <end>`, same pipeline outside VS Code
  extension/  VS Code command and webview panel
```

## Develop

Needs Node 22+ and git.

```sh
npm install
npm run build        # all packages
npm test             # core unit and git integration tests
npm run typecheck
```

Run the extension: open this folder in VS Code and press **F5** ("Run extension"). In the new
window, open a file in any git repository, select some lines, right-click and choose
**Why is this here?** (or run **Code Archaeologist: Why is this here?** from the command palette).

Install it in your normal VS Code instead: `npm run package -w packages/extension`, then
**Extensions: Install from VSIX…** and pick `packages/extension/code-archaeologist-0.2.0.vsix`.

## CLI

```sh
npm run build
node packages/cli/dist/cli.js trace <file> <start> <end> [--json] [--snapshots] [--keep-noise] [--story] [--model <id>] [--cache-dir <dir>]
```

Lines are 1-based and inclusive, matched against HEAD. `--story` asks Gemini for the summary,
per-commit notes and verdict and needs `GEMINI_API_KEY`. With `--cache-dir`, a rerun of the same
lines at the same HEAD reuses both the trace and the story, so recording a demo never waits on
the model.

## AI story

One Gemini call per trace (`packages/core/src/story.ts`), default model `gemini-3.5-flash` on
Google AI Studio's free tier:

- **Input:** the lines today, then per commit its id, date, author, message and the diff of the
  traced lines (trimmed to 60 lines). Above 25 commits, or about 30k tokens, middle commits are
  sent as their subject line only.
- **Output:** JSON with a one-sentence summary, a note per commit and a low/medium/high verdict
  with 3 to 5 reasons and things to check, validated with zod.
- **Citations:** every note and reason must cite ids from the input (`commit:b35fa73`,
  `pr:49659`). Citations that match nothing are dropped, and a claim left with none is shown as
  **unverified**. When the evidence gives no reason, the note says "No reason recorded."

In VS Code, set the key with **Code Archaeologist: Set Gemini API key** (kept in secret storage;
`GEMINI_API_KEY` in the environment also works) and the model with the `codeArchaeologist.model`
setting. Without a key the panel shows the raw history and a button to add one. The free tier is
sometimes overloaded (HTTP 503); the client retries with backoff, and a full trace can take a
minute or two.

## Demo snippet

Angular's URL sanitizer has ten years of security history in eleven lines:

```sh
git clone --filter=blob:none https://github.com/angular/angular.git
node packages/cli/dist/cli.js trace angular/packages/core/src/sanitization/url_sanitizer.ts 38 48
```

That gives 18 commits from 2016 to 2026 (plus one lint re-format skipped as noise), ending
with the September 2026 revert of a stricter `data:`/`vbscript:` block.

Backup snippets in the same repo:

| File | Lines | Commits | Story |
| --- | --- | --- | --- |
| `packages/common/http/src/xsrf.ts` | 94-127 | 4 (+1 Prettier migration skipped) | 2025 fixes for XSRF tokens leaking to protocol-relative URLs |
| `packages/router/src/url_tree.ts` | 479-498 | 23 (+2 skipped) | `serialize()`, with several land/revert/reland cycles, the latest in September 2026 |

Line numbers are for angular/angular at `ff0dbf1` (2026-10-01).
