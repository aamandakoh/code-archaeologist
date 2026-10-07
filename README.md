# Code Archaeologist

Select some lines in VS Code and ask **"Why is this here?"**. Code Archaeologist plays back
how those lines evolved, commit by commit, so you can see what changed, when, and (from
milestone 2 on) why, ending in a cited "safe to change?" verdict.

## Status

| Milestone | What it adds | State |
| --- | --- | --- |
| M0 | Workspaces, build, tests, extension skeleton | Done |
| M1 | `git log -L` trace, noise filter, CLI, raw history panel | Done |
| M2 | AI notes, summary and risk verdict (Gemini) | Next |
| M3 | GitHub PRs, review comments and issues | |
| M4 | Time-lapse UI polish | |
| M5 | Demo recording | |

## Layout

```
packages/
  core/       evidence engine: trace, parse, noise filter, cache. Never imports vscode.
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
**Extensions: Install from VSIX…** and pick `packages/extension/code-archaeologist-0.1.0.vsix`.

## CLI

```sh
npm run build
node packages/cli/dist/cli.js trace <file> <start> <end> [--json] [--snapshots] [--keep-noise] [--cache-dir <dir>]
```

Lines are 1-based and inclusive, matched against HEAD.

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
