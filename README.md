# AI PR Review Focus

Review Navigator is a GitHub-native tool that finds the logical code blocks in a pull request that deserve a human reviewer. It orders attention. It does not hunt for bugs, assign defect severity, or propose patches.

The foundation in this repository is milestone 1. It loads and validates configuration, defines the pipeline contracts, and fails closed. It does not call the GitHub REST API, parse a diff, run Tree-sitter, rank blocks, call an LLM, or post a comment.

`.github/workflows/pr-review-focus.yml` is an unprivileged pull request workflow. It runs the project checks and logs the pull request number, base SHA, head SHA, and event type from the Actions event. It does not need an LLM secret.

## Supported versions

| Tool    | Version     |
| ------- | ----------- |
| Node.js | `>=20.19.0` |
| npm     | `>=10.8.0`  |

Checked with Node.js 20.19.2 and npm 10.8.2. `.github/workflows/ci.yml` installs Node.js 20. `.github/workflows/pr-review-focus.yml` installs Node.js 24 LTS. The source targets ES2022 and the Node.js APIs from the Node.js 20.19 baseline.

## Setup

```bash
npm install
```

Copy `.env.example` to `.env` when a later milestone runs against GitHub. Keep real tokens in `.env` only. `.env` is gitignored.

```bash
npm run type-check
npm run lint
npm run format:check
npm test
npm run build
```

`npm run format` rewrites files with Prettier. The foundation has no CLI that reviews a pull request. `createFoundationPipeline()` throws `NotImplementedError` from every stage.

After `npm run build`, `node dist/github/report-pull-request-event.js` prints pull request metadata when `GITHUB_EVENT_PATH` points at a GitHub `pull_request` event file.

## Scripts

| Script                 | Purpose                                          |
| ---------------------- | ------------------------------------------------ |
| `npm run build`        | Compile `src` to `dist`                          |
| `npm run type-check`   | Type-check `src`, `tests`, and the Vitest config |
| `npm run lint`         | ESLint with type-aware TypeScript rules          |
| `npm run format`       | Write Prettier formatting                        |
| `npm run format:check` | Check Prettier formatting                        |
| `npm test`             | Run Vitest once                                  |

## Configuration

Environment variables:

| Variable              | Required                  | Purpose                                          |
| --------------------- | ------------------------- | ------------------------------------------------ |
| `GITHUB_TOKEN`        | Always                    | GitHub REST authentication for a later milestone |
| `LLM_PROVIDER`        | No                        | `claude`, `gpt`, or `none` (default `none`)      |
| `LLM_MODEL`           | No                        | Model name used when a provider is selected      |
| `ANTHROPIC_API_KEY`   | When provider is `claude` | Claude API key                                   |
| `OPENAI_API_KEY`      | When provider is `gpt`    | GPT API key                                      |
| `REVIEW_FOCUS_CONFIG` | No                        | Policy path, default `.github/review-focus.yml`  |

`loadConfig({ env })` reads that object alone. It does not merge `process.env`. `loadConfig()` with no argument reads `process.env`. Validation errors name the variable. They do not repeat the value.

`.github/review-focus.yml` is the review policy:

- `version` must be `1`.
- `selection.maxBlocks` is how many blocks a later ranking step may keep (1–100). The shipped default is 12.
- `selection.minBand` is the lowest band a later ranking step may keep: `low`, `medium`, or `high`. The shipped default is `medium`.
- `ignore` lists glob patterns. Matching is not implemented yet.
- `languages` lists Tree-sitter grammar names to keep. Parsing is not implemented yet. The shipped file lists `typescript` and `javascript`.
- `attention` lists enabled reasons. Detection is not implemented yet. The shipped file enables the full glossary.

Attention glossary:

| Reason                | Label                                   |
| --------------------- | --------------------------------------- |
| `public_api`          | Public API shape changed                |
| `control_flow`        | Control flow changed                    |
| `error_handling`      | Error handling changed                  |
| `data_shape`          | Data shape changed                      |
| `concurrency`         | Concurrency or async sequencing changed |
| `security_boundary`   | Security boundary changed               |
| `wide_span`           | Changed lines cover much of the block   |
| `cross_file_coupling` | The change reaches across files         |

A label names why a human should look. It does not claim a defect.

## Architecture

```text
config
github -> diff -> parser -> analysis -> prioritization -> llm -> publisher
shared
```

`llm` runs only for blocks prioritization has selected, and only when the provider is `claude` or `gpt`. Until that milestone, `explainAttention` throws for every provider setting, including `none`.

Filter `ignore` and `languages` before parsing. The parser maps syntax onto changed lines. It does not interpret policy.

| Module               | Responsibility                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/config`         | Load and validate environment variables and the review-focus policy with Zod                           |
| `src/github`         | Pull request event metadata, plus later GitHub REST reads of patches and file text                     |
| `src/diff`           | Files, hunks, and changed lines                                                                        |
| `src/parser`         | Tree-sitter logical blocks (functions, methods, classes, and the other kinds in `LOGICAL_BLOCK_KINDS`) |
| `src/analysis`       | Attention reasons for a logical block                                                                  |
| `src/prioritization` | Rank blocks and apply `maxBlocks` and `minBand`                                                        |
| `src/llm`            | Claude or GPT explanations for blocks already selected                                                 |
| `src/publisher`      | Post the focus report on the pull request                                                              |
| `src/shared`         | Errors, line ranges, and shared vocabulary                                                             |

`src/pipeline.ts` composes those modules. `src/index.ts` is the package entry. Import rules live in `MODULE_IMPORTS` in `src/shared/modules.ts`.

Tree-sitter packages are not installed yet. The `CodeParser` interface is the seam for that implementation, which keeps `npm install` free of native grammar builds.

## Layout

```text
src/config
src/github
src/diff
src/parser
src/analysis
src/prioritization
src/llm
src/publisher
src/shared
tests
.github/workflows/ci.yml
.github/workflows/pr-review-focus.yml
.github/review-focus.yml
```

## GitHub Actions

`PR Review Focus` runs on `pull_request` for `opened`, `reopened`, `synchronize`, and `ready_for_review`. The job checks out the merge commit with credentials left out of the git config, installs dependencies with the npm cache, then runs type-check, lint, test, and build. The last step prints:

```text
Review Focus pull request metadata
event: synchronize
number: 12
base: <40-character base SHA>
head: <40-character head SHA>
```

The same text is appended to the job summary. A missing or invalid event fails that step. The workflow does not call the GitHub REST API, an LLM, or the pull request comment API.

`CI` still runs on push and on the default pull request types. Both workflows can run for the same pull request.

### Security

- The workflow uses `pull_request`. It does not use `pull_request_target`.
- Permissions are `contents: read` and `pull-requests: read`.
- The workflow references no secrets. Fork pull requests therefore receive no `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or other repository secrets from this file.
- `actions/checkout` and `actions/setup-node` are pinned to full commit SHAs.
- Checkout sets `persist-credentials: false`.
- Steps that run `npm` or the metadata script set `GITHUB_TOKEN` and `GH_TOKEN` to empty so pull request scripts do not read the token.
- Package scripts from the pull request still execute. They execute in this read-only job, which is the unprivileged analysis path.

### Required GitHub settings

1. Enable Actions for the repository.
2. Under Settings → Actions → General → Workflow permissions, select **Read repository contents and packages permissions**. Leave **Allow GitHub Actions to create and approve pull requests** off.
3. Under Fork pull request workflows, keep approval for first-time contributors. Leave **Send secrets to workflows from fork pull requests** and **Send write tokens to workflows from pull requests** off.
4. Add no LLM secrets for this workflow. `GITHUB_TOKEN` is provided by Actions and this workflow does not use it to call the API.
5. Merge this workflow to the default branch before relying on it for fork pull requests. A same-repository pull request uses the workflow from the merge commit.

Node.js 24 LTS is the runtime for this workflow. The job timeout is 15 minutes. A new commit to the same pull request cancels the previous run.

## Security

- Put `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, and `OPENAI_API_KEY` in the environment when a later milestone needs them.
- Commit `.env.example` with empty placeholders. Do not commit `.env`.
- Do not commit private repository contents or pull request patches.
- `CI` requests `contents: read` only. `PR Review Focus` requests `contents: read` and `pull-requests: read`.

## Milestones

Ship these in order. Milestone 1 is the current tree. Milestones 2–9 are not started.

1. **Foundation and contracts** — Current. Tooling, module boundaries, validated configuration, and fail-closed pipeline stages.
2. **GitHub pull request intake** — Not started. Read pull request metadata, changed files, patches, and head file text with the GitHub REST API.
3. **Diff model** — Not started. Parse unified diffs into files, hunks, and changed line ranges.
4. **Logical blocks** — Not started. Use Tree-sitter to map changed lines onto functions, methods, classes, and other blocks.
5. **Attention analysis** — Not started. Decide which blocks deserve a human and record the attention reason. Report where to look, not defects.
6. **Prioritization** — Not started. Rank assessed blocks and keep the set allowed by the review-focus policy.
7. **LLM explanations** — Not started. Ask Claude or GPT to explain why a selected block deserves attention.
8. **Publication** — Not started. Post one pull request review comment that points at the selected blocks.
9. **GitHub Action** — Not started. Run the pipeline for a pull request and publish the focus report.

## Stack

Node.js, TypeScript in strict mode, npm, GitHub Actions, Zod, Vitest, ESLint, Prettier, and the GitHub REST API. Logical blocks will be parsed with Tree-sitter. Explanations will go through an `LlmProvider` for Claude or GPT. The MVP has no web server, dashboard, or database.
