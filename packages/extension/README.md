# Code Archaeologist

Select lines, right-click, **Code Archaeologist: Why is this here?** A panel opens beside the
editor with every commit that touched those lines, oldest first:

- Click a dot under the slider, drag the slider, or use ← → Home End. Stepping forward shows the
  lines that commit removed folding away, then the lines it added growing in.
- Dots are coloured by kind of change
  (feature, fix, revert, refactor, docs) with year labels, and the commits the verdict cites are
  ringed.
- Each step says how long after the previous change it came, links to the commit and to the
  file as it was at that commit, and keeps removed lines on screen as a diff (untick
  **Keep removed lines visible** to hide them).

Whitespace-only, formatting-only and license-header commits are skipped and listed separately.

Under the file name: every pull request or merge request behind these commits, found from the
commit message or, when the message names none, by asking GitHub or GitLab which one merged the
commit. Then a one-sentence summary and a Low / Medium / High risk verdict with cited
reasons (click one to jump to the commit it cites; the reasons about the commit on screen light
up as you scrub; "Hide reasons" folds the card down to the verdict) and things to check before
you change it.
Each commit card starts with its links on one line: the commit, the pull request or merge request
that merged it, and the file at that commit. Then the full commit message, and a short AI note with
chips for the other evidence it cites (issues, review comments, other commits). Under the diff are
the linked issues and review comments, read from GitHub or GitLab.

All of the settings below are also on one screen: run **Code Archaeologist: Open settings screen**
(or the gear in the panel's title bar). It has one-click setups for Gemini, the free Gemini
Flash-Lite and Mistral plans, OpenAI, OpenRouter, Ollama and LM Studio, a **Test connection** button, and fields for the GitHub and GitLab tokens.

The story is written by Gemini by default. Run **Code Archaeologist: Set LLM API key** with a key
from Google AI Studio, and pick the model with the `codeArchaeologist.model` setting (default
`gemini-3.5-flash`). Without a key you still get the raw history.

To use another LLM, set `codeArchaeologist.baseUrl` to its API URL and, for anything that speaks
the OpenAI chat completions format (OpenAI, OpenRouter, Ollama, LM Studio, vLLM), set
`codeArchaeologist.provider` to `openai` and `codeArchaeologist.model` to one of its model ids.
For example `http://localhost:11434/v1` with `llama3.1` runs on a local Ollama with no key.

GitHub context needs no setup for a few traces an hour. For more, run **Code Archaeologist: Set
GitHub token** with a fine-grained token that has read-only access to public repositories.

Code on GitLab works the same way, with merge requests in place of pull requests. Run **Code
Archaeologist: Set GitLab token** with a legacy personal access token (Personal access tokens > **Generate legacy token**) that has the `read_api` scope (GitLab
needs one for private projects and for comments). gitlab.com and hosts named like
`gitlab.example.com` are recognised from the `origin` remote; for any other self-hosted GitLab,
set `codeArchaeologist.gitlabUrl` to its address. The token is sent only to gitlab.com and to the
GitLab in that setting, so for a self-hosted GitLab set it even when its name has "gitlab" in it.

The LLM API URL and provider and the GitLab URL are read from your user settings only, never from a
workspace's `.vscode/settings.json`, so a repository you open cannot send your keys elsewhere.
