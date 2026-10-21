# memory-system: the brain's tools

Node scripts (standard library only) that read and index your brain: the markdown notes in
`~/.claude/projects/<slug of ~/ace>/memory/`, where `<slug>` is the workspace's full path with every character that
is not a letter or digit replaced by `-` (the folder name Claude Code itself uses).

| Command | What it does |
|---|---|
| `node "$HOME/ace/Code/memory-system/recall.mjs" "<topic>"` | Search every note (BM25 over name, description and body). Also the duplicate check before writing a note. `--top N`, `--json`. |
| `node "$HOME/ace/Code/memory-system/reindex.mjs"` | Rebuild everything the Stop hook rebuilds: `_manifest.json`, the type maps (`_MOC-feedback.md` ...), the sitemap (`_sitemap.json`, `_SITEMAP.md`, one `_MOC-<section>.md` per section) and the home-folder router. Prints `[reindex] ok`. |
| `node router-audit.mjs` | Checks `MEMORY.md` against the router budgets (bytes, pin lines, line length). |
| `node sitemap-audit.mjs` | Checks the sitemap: duplicate sections or topics, counts that do not add up, notes listed twice or under the wrong home. `--verdict` prints one line. |
| `node verify-memory-pass.mjs --sid <session id>` | The oracle the wrap-up gate uses: did this session record enough well-formed notes for the work it did? |
| `node corrections.mjs --list` | Corrections typed into the dashboard's sitemap page ("This is wrong"), and `--done <n> "<what changed>"`. |
| `node condense-transcript.mjs [N]` | Condenses the N largest past session transcripts into `logs/temp/_mine-digests/` for pattern mining. |

`build-manifest.mjs`, `build-mocs.mjs`, `build-sitemap.mjs` and `build-home-router.mjs` are the builders `reindex`
runs in order. `lib/notes.mjs` is the one shared note reader; `lib/sitemap.mjs` the sitemap model.
`sitemap/` (`tree.json`, `placement.json`, `skills.json`) is your sitemap registry: the sections and topics notes
are filed under. `aliases.json` lists words recall treats as the same thing.

Environment overrides (tests and special setups): `MEMSYS_MEM_DIR` / `CLAUDE_MEM_DIR` (the memory folder),
`MEMSYS_ROOT` (the workspace root), `MEMSYS_SITEMAP_DIR`, `MEMSYS_HOOKS_DIR`.
