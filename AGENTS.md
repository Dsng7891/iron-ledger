# AGENTS.md

《铁与账本》Iron & Ledger — TUI nation-simulator. Bun + TypeScript + `@opentui/core`.

## Commands

```bash
bun install
bun test                                  # 141 tests, ~2s
bun test test/sim/worldgen.test.ts        # single test file
bun run typecheck                         # = tsc --noEmit
bun start                                 # random seed
bun run dev                               # fixed seed 12345 (reproducible runs)
bun run dev -- --seed=999 --autoplay      # extra args pass through after --
bun run balance                           # headless econ stress (8 worlds × 200y)
```

No linter or formatter. CI: GitHub Actions (`.github/workflows/ci.yml` = typecheck + test + sim/UI boundary check) runs on every push — only push green. Verification order: `bun run typecheck` → `bun test`.

## Current status (verified)

- No open blocker. `palette.ts` encoding corruption was fixed by full rewrite (commit `4810494`); `tsc --noEmit` is clean and CI enforces it. Map mouse interaction (#1), map snapshot tests (#2), province search (#3) shipped in commit `9d574d6` (167 tests green). See `STATUS.md` §3.1 for the corruption history.

## Hard architecture rules

- `src/sim/**` must never import UI modules (checked by grep; keep it true). Sim runs headless for balance tests.
- UI never mutates `GameState` directly — all changes go through the `Command` bus in `src/state/store.ts` (log / undo / replay).
- `src/sim/types.ts` is the single source of truth for core types. `src/data/techs.ts` effects are declarative and interpreted by `src/sim/modifier.ts` — never hardcode multipliers in engine code.
- Same meaning = same color, always defined in `src/ui/theme.ts` (`SEMANTIC`).

## Editing rules (this repo got burned)

- **Never edit files via PowerShell pipelines** (`Get-Content | Set-Content`, `-replace`). PS 5.1 reads with the system codepage and writes UTF-8, destroying Chinese comments and eating newlines — that's what broke `palette.ts`. Use the `edit`/`write` tools only.
- Some files already contain literal `�` (U+FFFD) damage in comments (`index.ts`, `src/ui/layout.ts`, `STATUS.md`). Don't reintroduce it.
- OpenTUI API: check `node_modules/@opentui/core/**/*.d.ts` instead of guessing. Known traps: `BorderStyle` is `"rounded"` not `"round"`; `FrameBufferOptions` has no `backgroundColor` (use `clear()`); event enum is `CliRenderEvents`.

## Toolchain quirks

- `tsconfig.json`: `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` (use `import type`) + `allowImportingTsExtensions` (imports include the `.ts` extension — keep doing that).
- Runtime is Bun, ESM (`"type": "module"`): no `require()` in source.
- Determinism: `src/sim/rng.ts` (mulberry32) makes a seed produce an identical world; tests rely on this.
- Saves live at `~/.iron-ledger/saves/`. CLI flags: `--seed=N --load=<id> --autoplay --export=<id>` (export generates + saves without starting the UI).

## GitHub

- Remote: `origin` → https://github.com/Dsng7891/iron-ledger (public), default branch `main`.
- **Leverage GitHub actively**: track work as issues (mirror/extend `TODO.md` priorities), use feature branches + PRs for non-trivial changes, and only push with `bun run typecheck` + `bun test` green.
- Auth: `gh` CLI is **not installed** (install with `winget install GitHub.cli` if needed). A working OAuth token (scopes `repo workflow gist`) is stored in Git Credential Manager — plain `git push` already works; for REST API calls fetch it with `printf "protocol=https\nhost=github.com\n\n" | git credential fill`.
- GitHub API gotcha via PS 5.1: JSON bodies containing non-ASCII must be sent as UTF-8 **bytes** (`[Text.Encoding]::UTF8.GetBytes($json)`) or the request 400s; console output of Chinese also garbles — that's display only.
- `git push` sometimes fails with transient `Recv failure: Connection was aborted` — just retry (takes ~3 attempts when the network is bad).

## Docs

- `STATUS.md` — handoff doc: architecture rules, past pitfalls (NaN from `a + b ?? 0`, annual-vs-monthly interest, CJK/double-width chars). **Partially stale** — its app.ts/inspector errors are fixed; trust `tsc`.
- `TODO.md` — task list with priorities; `DESIGN.md` — design spec.
