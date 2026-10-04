# AGENTS.md

Project instructions for AI PR Review Focus (Review Navigator).

## Product

Review Navigator points human reviewers at the logical blocks in a GitHub pull request that deserve attention. A result names a block, a location, and an attention reason.

Write that result from the pull request under review. Defect reports, bug severity, and suggested patches stay outside the product.

## Preserve working behavior

Read the module and its tests before changing them. Keep the exports in `src/index.ts` stable unless the task changes those contracts.

Leave unrelated modules as they are. Finish a change only when the existing tests pass and these commands pass:

- `npm run type-check`
- `npm run lint`
- `npm test`
- `npm run build`

## Architecture

Runtime order is `PIPELINE_STAGES` in `src/shared/modules.ts`. Responsibilities are `MODULE_BOUNDARIES` in that file. Allowed imports are `MODULE_IMPORTS`. Update those three together when a module is added.

`src/pipeline.ts` is the composition root. `shared` imports no other project module. Other modules import only the targets listed for them. `index` may import `pipeline` and any module. No cycles.

Cross-module data uses the interfaces in each module's `types.ts`.

Apply `ignore` and `languages` before parsing. Parsing maps syntax onto changed lines and does not interpret policy.

Stages that are not built yet throw `NotImplementedError`. Replace that throw in the milestone that owns the stage. Return a value only after the stage has computed it from its input.

`llm` explains blocks that prioritization has already selected, and only when configuration selects `claude` or `gpt`. Until that milestone, `explainAttention` throws for every provider setting, including `none`.

## Coding conventions

Use the compiler, ESLint, and Prettier settings already in the repo. Read `tsconfig.json`, `eslint.config.js`, and `package.json` for the current flags.

- Keep one concept in each file. Export cross-module contracts as interfaces or discriminated unions.
- Parse the process environment and `.github/review-focus.yml` with Zod inside `src/config` before another module reads that data.
- Use `.js` extensions on relative imports, and `import type` for type-only imports.
- Signal failures with `ReviewNavigatorError` or a subclass. Name the missing variable in a config error. Leave the variable's value out of the message.

## Security

Read `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, and `OPENAI_API_KEY` from the environment through `loadConfig`.

Keep real values in an untracked `.env`. `.env.example` holds empty placeholders. Log the policy path and the names of missing variables. Leave `AppConfig` and its token fields out of logs.

Commit synthetic fixtures only. Leave private repository contents and private pull request patches uncommitted.

Call GitHub with the token the workflow already has.

`.github/workflows/pr-review-focus.yml` is the unprivileged `pull_request` workflow. It logs event metadata and runs the checks. Keep LLM calls and comment publication out of it. Leave `pull_request_target` unused. Keep third-party Actions pinned to a full commit SHA. Grant write permissions only in the milestone that publishes a review.

## Tests

Put tests in `tests/` and run them with Vitest.

Cover validation, module boundaries, and fail-closed stages with synthetic inputs. A new stage replaces its `NotImplementedError` test with a fixture test that asserts computed output.

## Milestones

Ship the nine milestones in the README in order. This tree is milestone 1, plus the unprivileged pull request workflow that validates and logs event metadata. Milestones 2–9 in the README are not started. Start the next milestone when the task asks for it.
