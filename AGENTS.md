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

No linter, formatter, or CI config exists. Verification order: `bun run typecheck` → `bun test`.

## Current known blocker (verified)

- `src/ui/views/palette.ts` is encoding-corrupted (bytes mangled, comments swallowed newlines). It is the **only** file failing `tsc --noEmit`, and it breaks `bun start`. Fix by rewriting the whole file with `write` — see STATUS.md §3.1. `help.ts`, `renderer.ts`, `statusbar.ts` were already rewritten this way.

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

## Docs

- `STATUS.md` — handoff doc: architecture rules, past pitfalls (NaN from `a + b ?? 0`, annual-vs-monthly interest, CJK/double-width chars). **Partially stale** — its app.ts/inspector errors are fixed; trust `tsc`.
- `TODO.md` — task list with priorities; `DESIGN.md` — design spec.
