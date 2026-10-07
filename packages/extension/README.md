# Code Archaeologist

Select lines, right-click, **Why is this here?** A panel opens beside the editor with every
commit that touched those lines, oldest first. Drag the slider (or use ← →) to see the lines
at each commit, with the lines that commit added highlighted.

Whitespace-only, formatting-only and license-header commits are skipped and listed separately.

Pinned at the top: a one-sentence summary and a Low / Medium / High risk verdict with cited
reasons (click one to jump to the commit it cites) and things to check before you change it.
Each commit gets a short AI note with chips linking to the commits and PRs it cites.

The story is written by Gemini. Run **Code Archaeologist: Set Gemini API key** with a key from
Google AI Studio, and pick the model with the `codeArchaeologist.model` setting (default
`gemini-3.5-flash`). Without a key you still get the raw history.
