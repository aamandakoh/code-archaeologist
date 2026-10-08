# Code Archaeologist

Select lines, right-click, **Why is this here?** A panel opens beside the editor with every
commit that touched those lines, oldest first, as a time-lapse:

- **Play** (or Space) steps through the history at 1×, 2× or 4×. Each step shows the lines
  that commit removed in red folding away, then the lines it added growing in.
- Drag the slider, click a dot under it, or use ← → Home End. Dots are coloured by kind of change
  (feature, fix, revert, refactor, docs) with year labels, and the commits the verdict cites are
  ringed.
- Each step says how long after the previous change it came, links to the commit and to the
  file as it was at that commit, and can keep removed lines on screen as a diff.

Whitespace-only, formatting-only and license-header commits are skipped and listed separately.

Pinned at the top: a one-sentence summary and a Low / Medium / High risk verdict with cited
reasons (click one to jump to the commit it cites; the reasons about the commit on screen light
up as you scrub; "Hide reasons" folds the card down to the verdict) and things to check before
you change it.
Each commit gets a short AI note with chips linking to the commits, PRs, review comments and
issues it cites. Under it are the commit's pull request, linked issues and review comments, read
from GitHub.

The story is written by Gemini by default. Run **Code Archaeologist: Set LLM API key** with a key
from Google AI Studio, and pick the model with the `codeArchaeologist.model` setting (default
`gemini-3.5-flash`). Without a key you still get the raw history.

To use another LLM, set `codeArchaeologist.baseUrl` to its API URL and, for anything that speaks
the OpenAI chat completions format (OpenAI, OpenRouter, Ollama, LM Studio, vLLM), set
`codeArchaeologist.provider` to `openai` and `codeArchaeologist.model` to one of its model ids.
For example `http://localhost:11434/v1` with `llama3.1` runs on a local Ollama with no key.

GitHub context needs no setup for a few traces an hour. For more, run **Code Archaeologist: Set
GitHub token** with a fine-grained token that has read-only access to public repositories.
