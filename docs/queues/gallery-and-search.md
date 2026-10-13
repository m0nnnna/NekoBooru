# Gallery and search - open queue

The home gallery, library search, the post page's display, and browsing other
boorus. Rows: one line and a pointer (`- [ ] **what** · area · evidence · status`);
claim with `**TAKEN <date> <who>**` before starting; the landing commit deletes
the row. Where a row and its evidence disagree, the evidence wins.

## Open

- [ ] **Dark mode leaves un-coloured text dark on a dark background app-wide: `.dark-mode` sits on `#app`, but the global `body { color: var(--text-primary) }` resolves against the light palette, so any element without its own colour inherits dark text. The batch panel was patched locally; the root fix is setting the text colour on `#app` (or moving the theme class to `body`) and auditing views that patched around it.** · frontend theme · evidence: `frontend/src/App.vue` (`.dark-mode` root class), `frontend/src/components/batch/BatchPanel.vue` (local colour patch), Stage 0 redesign `058d74a` · UNCLAIMED
