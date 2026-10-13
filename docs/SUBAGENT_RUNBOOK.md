# Subagent deployment runbook

How to run several agents on one program in this repo without paying for
it twice. CLAUDE.md rule 2 (worktree → fast-forward) and "Work tracking"
(the queues) are the rules of record; this page is how to apply them
efficiently. Read it before orchestrating more than two subagents.

## 1. Shape the wave: few fat lanes, not many agents

- **Three or four lanes at a time, each with a large batch.** Every agent
  pays a fixed cost (worktree, dependency setup, reading CLAUDE.md and the
  plan) before it does any work. Ten small agents pay it ten times; one lane
  with a dozen rows pays it once. Make batches bigger, never add agents to
  make them smaller.
- **Cut lanes by file ownership, not by topic.** Before dispatch, write down
  which paths each lane owns and check that no file appears in two lanes.
  The natural cuts here:
  - `frontend/src/**` (one lane; split further only by disjoint directories,
    e.g. one lane owns three views and their new components, another owns
    everything else)
  - `browser-extension/**`
  - `backend/**` + `tests/**`
- **`frontend/dist/` is never a lane's job.** It is content-hashed, so any
  two branches that rebuild it conflict. Lanes change `frontend/src/` only;
  the landing rebuilds `dist` once.
- **Rows that cut across lanes wait for the next wave.** A row whose fix
  touches files owned by two lanes (a shared registry, a rule duplicated in
  the extension and the web app) goes into wave 2, after the landing.
- **Model:** lanes, reviews and landings on the strongest coding model you
  have (Opus). A small model only for trivial, repetitive work where a test
  or the compiler is the whole check (filing rows, renaming a doc anchor) —
  never for a lane that writes tests or decides anything.

## 2. Claim before dispatch

- Mark every row in the batch `**TAKEN <date> <lane>**` with one script and
  commit that change alone, before any worktree exists. A row shared by two
  lanes names both (`L1-front+L3-ext`) and each lane does its half.
- After the landing, grep the queues for the wave's marks. A mark left on a
  row a lane reported DONE or REFUTED is a dropped deletion.

## 3. The brief: a work order, ≤40 lines

A brief contains only:

1. **Setup.** `git merge --ff-only main` first (a worktree can be created at
   an old commit) and the SHA main must include. If `frontend/node_modules`
   is missing, a temporary directory junction to the main checkout's copy,
   removed before hand-back. The backend venv lives in the main checkout
   (`../../../../venv/...` from a worktree's `tests/`).
2. **The batch.** "Every row marked `TAKEN <date> <lane>`", plus the plan
   section to read. The lane reads each row's evidence itself.
3. **What the lane owns**, and the paths it must not touch (other lanes'
   files, `docs/queues`, `frontend/dist`).
4. **Facts that bound the work**, one line each: compatibility it must keep
   (a facade import path, a patched module path, a snapshot), the owner's
   live instance on port 8772 is off limits, no credentials, no push, no
   merge.
5. **How rows end and how to test** (sections 4 and 5).
6. **The report fields**, capped at 30 lines.

No history, no rationale, no restated CLAUDE.md. A judgment call gets a
one-line rule ("if the tree differs from the plan, follow the tree and say
so").

## 4. Every row ends one of three ways

- **DONE**: a commit that fixes it with a test; the test's red output
  from before the fix is pasted in the commit body. A test that cannot fail
  is not a test.
- **REFUTED**: the tree no longer has the problem; the evidence (file,
  symbol, commit) is named.
- **DESIGN**: a lane cannot decide it (an owner choice, an external
  limit). One line of verdict for the owner; the row stays.

Pure code moves (splits) are their own commits, separate from behaviour
changes, so a reviewer can skim the move and read the change. A defect the
lane introduced is fixed in-lane, never filed as a row.

Findings outside the batch are filed as they are found: lanes in worktrees
do not edit `docs/queues` (parallel appends conflict), so each finding goes
in the report verbatim as a queue row, naming its queue file.

## 5. Tests: touched files in the lane, suites once at the landing

- A lane runs only the test files that cover what it changed, once at the
  end, plus a compile check (`npx vite build --outDir <temp dir outside the
  repo>` for the frontend, `node --check` for extension scripts). It never
  runs the full suites.
- The landing runs every suite once: `npm run test`, the backend
  `unittest discover`, and each `node browser-extension/*.test.js`.
- A browser check, when a lane does one, uses a throwaway backend on another
  port with every `NEKO_*` path in a temp dir, and stops every server it
  started before handing back. A dev server left running from a worktree
  holds the folder open and blocks its removal.

## 6. The report: ≤30 lines, written for the landing

Branch tip; per row its outcome and SHA; new rows verbatim with their queue;
line counts of new or split files; anything CLAUDE.md must now point at (a
moved model list, a new module map); and the lane's **tool-call count**,
which is the efficiency number to compare waves by.

The orchestrator copies each report into a holding file in its scratchpad
the moment it arrives. That file, not the conversation, is the landing's
input.

## 7. One batched landing per wave

Wait for every lane, then land them together:

1. Rebase each branch onto main in turn and fast-forward
   (`git merge --ff-only`). Run the rebase on its own and read its exit
   code before doing anything else; never pipe a rebase, merge or test run
   through `tail`/`head`, which hides its failure.
2. Run the full suites once on the result. Only the known baseline failures
   in CLAUDE.md may be red.
3. Queue edits are the union of every lane's outcomes: delete DONE and
   REFUTED rows, append verdicts to DESIGN rows, file new rows verbatim.
4. Update CLAUDE.md pointers the lanes reported.
5. `npm run build` and commit `frontend/dist` alone as "Rebuild frontend
   assets".
6. Remove worktrees and branches; grep for leftover claim marks.

If a branch finishes after the landing starts, it waits for the next one.

## 8. Mechanics that bit us

- **Line endings.** Several files are CRLF (`HomeView.vue`, `README.md`,
  `CLAUDE.md`, some extension scripts). `sed -i` and naive Python rewrites
  turn a CRLF file into LF and produce a whole-file diff. Check
  `git ls-files --eol <file>` before and after any scripted edit.
- **Worktree removal.** `git worktree remove` fails with "Permission denied"
  or "resource busy" while the shell's cwd is inside the worktree or a
  process (often a leftover Vite server) holds it. `cd` to the repo root,
  find and stop the process, then `rm -rf` the folder and
  `git worktree prune`.
- **A lane cut off mid-run is resumed, not replaced.** Inspect its worktree
  (commits, modified files) and message the same agent with that state. A
  fresh agent in the same worktree rediscovers everything.
- **Never dispatch into another lane's worktree**, and never remove a
  worktree a lane could still resume in.
- **Never `git stash`** in a multi-worktree run; the stash stack is shared.
  Use a temporary WIP commit.
