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
| M3 | GitHub PRs, review comments and issues (and GitLab merge requests) | Done |
| M4 | Time-lapse UI polish | Done |
| M5 | Demo recording | Next |

## Install

No build needed. Download `code-archaeologist-<version>.vsix` from the
[latest release](https://github.com/aamandakoh/code-archaeologist/releases/latest), then either:

- in VS Code, open the command palette and run **Extensions: Install from VSIX…**, then pick the file, or
- from a terminal: `code --install-extension code-archaeologist-<version>.vsix`

Reload VS Code if asked. Select some lines in a file inside a git repository, right-click and choose
**Why is this here?**. Run **Code Archaeologist: Open settings** to add an LLM API key and,
optionally, a GitHub or GitLab token.

The repository is private for now, so the release download only works for people with access to it.
With the GitHub CLI you can also fetch it from a terminal:
`gh release download --repo aamandakoh/code-archaeologist --pattern '*.vsix'`.

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

Build your own `.vsix` instead: `npm run package -w packages/extension` writes
`packages/extension/code-archaeologist-<version>.vsix`, which installs as above.

Cut a release: bump `version` in `packages/extension/package.json`, push to `main`, then push a
matching tag (`git tag v0.7.0 && git push origin v0.7.0`). The Release workflow builds the `.vsix`
and attaches it to a GitHub Release for that tag.

## CLI

```sh
npm run build
node packages/cli/dist/cli.js trace <file> <start> <end> [--json] [--snapshots] [--keep-noise] [--no-github] [--gitlab-url <url>] [--story] [--provider gemini|openai] [--base-url <url>] [--model <id>] [--cache-dir <dir>]
```

Lines are 1-based and inclusive, matched against HEAD. `--story` asks Gemini for the summary,
per-commit notes and verdict and needs `GEMINI_API_KEY`. When `origin` is on github.com, each
commit's pull request, review comments and linked issues are read too, with `GITHUB_TOKEN` if set
(`--no-github` skips this). With `--cache-dir`, a rerun of the same lines at the same HEAD reuses
the trace, the GitHub responses and the story, so recording a demo never waits on the network.

## GitHub context

`packages/core/src/github.ts` adds the "why" that commit messages leave out:

- **Pull request:** from the message when the merge tool wrote it (`(#123)` after the subject,
  Angular's `PR Close #123`, a merge commit), else GitHub's "pull requests for a commit"
  endpoint. Then its description (PR template boilerplate stripped), line comments on the traced
  file, review summaries and the conversation, bots left out.
- **Linked issues:** `Fixes #n`, `Closes #n`, `Resolves #n` in the commit or PR.
- **Reverts:** `Reverts #n` in the PR, or `This reverts commit <sha>` for a commit in the
  timeline. The comments on the reverted PR that mention the revert are attached to the revert,
  because that is usually where the reason is.

All of it goes into the prompt with citable ids (`pr:67692`, `review:fc9b2d6-1`, `issue:31462`),
and the panel shows the PR, issues and comments under each commit. Each PR costs four requests,
so the 18-commit demo trace makes about 60 the first time and none after that (responses are
cached for a week).

Without a token GitHub allows 60 requests an hour, about one trace. Use a fine-grained token with read-only access
to public repositories: **Code Archaeologist: Set GitHub token** in VS Code (kept in secret
storage), or `GITHUB_TOKEN` for the CLI. If GitHub fails (rate limit, bad token), the panel says
so and the story is written from what was found.

### GitLab

When `origin` is on GitLab, `packages/core/src/gitlab.ts` reads the same things from the GitLab
API instead: each commit's merge request (from "See merge request group/project!12" in a merge
commit, else GitLab's "merge requests for a commit"), its comments with line comments on the
traced file first, the issues it closes ("Closes #7") and the merge request a revert undid.
Merge requests show as `!12`. Remotes on gitlab.com or a host with "gitlab" in its name are found
on their own; for another self-hosted host set `codeArchaeologist.gitlabUrl` (CLI:
`--gitlab-url` or `GITLAB_URL`). Private projects, and comments even on public gitlab.com
projects, need a personal access token with `read_api`: **Code Archaeologist: Set GitLab token**
in VS Code, or `GITLAB_TOKEN` for the CLI.

## AI story

One Gemini call per trace (`packages/core/src/story.ts`), default model `gemini-3.5-flash` on
Google AI Studio's free tier:

- **Input:** the lines today, then per commit its id, date, author, message, its PR's title and
  description, up to 6 review comments, linked issues and the diff of the traced lines (trimmed
  to 60 lines). Above 25 commits, or about 30k tokens, middle commits are
  sent as their subject line only.
- **Output:** JSON with a one-sentence summary, a note per commit and a low/medium/high verdict
  with 3 to 5 reasons and things to check, validated with zod.
- **Citations:** every note and reason must cite ids from the input (`commit:b35fa73`,
  `pr:49659`). Citations that match nothing are dropped, and a claim left with none is shown as
  **unverified**. When the evidence gives no reason, the note says "No reason recorded."

In VS Code, **Code Archaeologist: Open settings** shows all of this as a form, with presets and
a connection test. Or set the key with **Code Archaeologist: Set LLM API key** (kept in secret storage;
`GEMINI_API_KEY` in the environment also works) and the model with the `codeArchaeologist.model`
setting.

Gemini is only the default. `codeArchaeologist.baseUrl` (CLI: `--base-url`) points the story at
another API, and `codeArchaeologist.provider` set to `openai` (CLI: `--provider openai`) switches
to the OpenAI chat completions format, so OpenAI, OpenRouter, Ollama, LM Studio, vLLM or LiteLLM
all work. That format needs a model id, takes its key from the same command or `OPENAI_API_KEY`,
and needs no key for a server on your own `baseUrl`. If the server refuses a JSON schema the
client falls back to plain JSON mode. Without a key the panel shows the raw history and a button to add one. The free tier is
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
