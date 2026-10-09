# Code Archaeologist

Select lines, right-click, **Code Archaeologist: Why is this here?** A panel opens beside the
editor with every commit that touched those lines, oldest first:

- Click a dot under the slider, drag the slider, or use ← → Home End. Stepping forward shows the
  lines that commit removed folding away, then the lines it added growing in.
- Dots are coloured by kind of change
  (feature, fix, revert, refactor, docs) with year labels, and the commits the flags and reasons cite are
  ringed. **View all N commits** under the slider opens a list of every commit to pick from.
- Each step says who made the change, when, and how long after the previous change it came, links
  to the commit and to the file as it was at that commit, and keeps removed lines on screen as a
  diff (untick **Keep removed lines visible** to hide them).

Whitespace-only, formatting-only and license-header commits are skipped and listed separately.

Under the file name: a warning score out of 10, a one-sentence summary, warning flags (security,
reverted, broke before, borrowed code, tests added) and cited reasons. The score adds up the kinds
of flag found: security 3, reverted 3, broke before 2, borrowed code 1, tests added 1. Click a flag
or reason to jump to the commit it cites; the ones about the commit on screen light up as you
scrub; click the score's row to fold the card down to the score and summary. Below them are things
to check before you change it.
Each commit card starts with its links on one line: the commit, the pull request or merge request
that merged it (found from the commit message or, when the message names none, by asking GitHub or
GitLab), its Jira tickets, and the file at that commit. Then a short AI note with chips for the other
evidence it cites (issues, review comments, Jira tickets, other commits), and the diff. Under the
diff, dropdowns hold the full commit message, the pull request's description, linked issues and
comments, and each Jira ticket's type, status, description and comments.

All of the settings below are also on one screen: run **Code Archaeologist: Open settings screen**
(or the gear in the panel's title bar). It has one-click setups for Gemini, the free Gemini
Flash-Lite and Mistral plans, OpenAI, OpenRouter, Ollama and LM Studio, a **Test connection** button, fields for the GitHub and GitLab tokens, and Jira.

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

Jira tickets named in commit messages and pull request or merge request titles and descriptions
(like `PAY-412`) become evidence too. On the settings screen, set the Jira URL, and for Jira Cloud
your Atlassian email with an API token, or for Data Center or Server a personal access token. The
token is kept in secret storage and only ever sent to that Jira URL. Optional project keys limit
which keys count, and "Ignore comments from" leaves out bots by name ("mentioned this issue in a
commit" notices are always left out); **Test connection** checks it all.

The LLM API URL and provider, the GitLab URL and the Jira URL are read from your user settings only, never from a
workspace's `.vscode/settings.json`, so a repository you open cannot send your keys elsewhere.
