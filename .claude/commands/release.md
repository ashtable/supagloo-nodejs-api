---
description: PR the current version branch into main, merge it, then cut and push the next version branch
argument-hint: "[next-branch e.g. v0.0.4] — optional; defaults to a patch bump of the current branch"
allowed-tools: Bash(git status:*), Bash(git rev-parse:*), Bash(git log:*), Bash(git checkout:*), Bash(git pull:*), Bash(git push:*), Bash(gh pr create:*), Bash(gh pr merge:*)
---

## Context

- Current branch: !`git rev-parse --abbrev-ref HEAD`
- Working tree status: !`git status --short`
- Commits on this branch vs main: !`git log --oneline main..HEAD`

## Task

Ship the current version branch and cut the next one. The current branch is a version
branch such as `v0.0.3`.

**Target next branch:** $ARGUMENTS
If no argument was given above, compute it by incrementing the patch number of the current
branch (e.g. `v0.0.3` → `v0.0.4`).

Run these steps **in order**. If any step fails or a precondition isn't met, stop and report
what you found — do not attempt to work around it.

1. **Preconditions.** Confirm the working tree is clean (the status above is empty). If there
   are uncommitted changes, stop and tell the user to commit/push first — this command only
   releases already-committed work. Also confirm the current branch is a version branch and is
   not `main`.
2. **Open the PR** into `main`, deriving a concise title and body from the commits listed above:
   `gh pr create --base main --head <current-branch> --title "<summary>" --body "<summary of commits>"`.
   If a PR for this branch already exists, reuse it instead of failing.
3. **Merge it:** `gh pr merge <current-branch> --merge` (merge by branch name — no PR number to parse).
4. **Update main:** `git checkout main && git pull`.
5. **Cut the next branch:** `git checkout -b <next-branch>`.
6. **Push it:** `git push -u origin <next-branch>`.
7. Report the merged PR, the fast-forward range on `main`, and the new branch now tracking origin.

**Never** add any co-authorship or co-attribution trailer to commits or PR bodies.
