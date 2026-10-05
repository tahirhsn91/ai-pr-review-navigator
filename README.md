# AI PR Review Focus

Review Navigator is a GitHub-native tool that finds the logical code blocks in a pull request that deserve a human reviewer. It orders attention. It does not hunt for bugs, assign defect severity, or propose patches.

The library loads and validates configuration, retrieves a pull request diff from the GitHub REST API when a caller supplies a token, maps changed lines in TypeScript and JavaScript onto logical blocks, asks Claude or GPT whether a candidate block changes behavior, ranks those blocks into review groups, and can publish that report on the pull request. LLM explanations of selected blocks are not implemented. That pipeline stage still fails closed.

`.github/workflows/pr-review-focus.yml` is an unprivileged pull request workflow. It runs the project checks and logs the pull request number, base SHA, head SHA, and event type from the Actions event. That workflow does not call the GitHub REST API and does not need an LLM secret.

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

`npm run format` rewrites files with Prettier. The foundation has no CLI that reviews a pull request. `createFoundationPipeline()` throws `NotImplementedError` from the stages that are not implemented. `assessBlocks` runs semantic analysis when the caller supplies a provider. `rankBlocks` selects and ranks assessed blocks. `publish` posts the report when the caller supplies `createReviewPublisher`.

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
- `selection.maxBlocks` is how many blocks the summary displays (1–100). The shipped default is 12. Important blocks past that limit remain in the report as overflow.
- `selection.minBand` is the lowest band the summary displays: `low`, `medium`, or `high`. The shipped default is `medium`. Low-priority blocks stay in the report when this band hides them from the summary.
- `ignore` lists glob patterns. Matching is not implemented yet.
- `languages` lists Tree-sitter grammar names to keep. Parsing is not implemented yet. The shipped file lists `typescript` and `javascript`.
- `attention` lists enabled reasons. A confident assessment records one of these reasons only when that code appears in the model's behavior explanation.
- `criticality` lists repository statements about what is business-critical. The semantic analyzer forwards those statements to the model. It does not invent rules that are absent from this list. The shipped file names payment capture and account authorization.

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

`analysis` asks an injected model whether each candidate block changes behavior. The model is Claude or GPT when the caller builds one with `createLlmProvider`. `explainAttention` still throws for every provider setting, including `none`, until the explanation milestone. The foundation pipeline does not read an API key and does not call a model by itself.

Filter `ignore` and `languages` before parsing. The parser maps syntax onto changed lines. It does not interpret policy.

| Module               | Responsibility                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `src/config`         | Load and validate environment variables and the review-focus policy with Zod                       |
| `src/github`         | Pull request event metadata and GitHub REST reads of patches and file contents at a commit SHA     |
| `src/diff`           | Files, hunks, changed lines, and base and head source for a pull request diff                      |
| `src/parser`         | TypeScript and JavaScript logical blocks from the base and head syntax trees                       |
| `src/analysis`       | Behavioral assessment of a changed logical block                                                   |
| `src/prioritization` | Select and rank changed blocks into review groups under the policy budget                          |
| `src/llm`            | Claude or GPT completions for that assessment. Explanations of selected blocks are not implemented |
| `src/publisher`      | Post one idempotent focus comment and inline anchors on the pull request                           |
| `src/shared`         | Errors, line ranges, and shared vocabulary                                                         |

`src/pipeline.ts` composes those modules. `src/index.ts` is the package entry. Import rules live in `MODULE_IMPORTS` in `src/shared/modules.ts`.

TypeScript and JavaScript are parsed with the TypeScript compiler API. `createParserRegistry()` can register another language later. Tree-sitter grammars are not installed, so `npm install` does not build a native parser.

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

## Diff processing limitations

`processPullRequestDiff` and `createGitHubClient` perform the retrieval. `createFoundationPipeline` does not, and the pull request workflow does not call either one.

- File text comes from the Contents API with `ref` set to the immutable base or head commit SHA. Added files are not fetched at the base SHA. Deleted files are not fetched at the head SHA. A rename is fetched from `previous_filename` at the base SHA and from the new path at the head SHA. A rename without `previous_filename` is marked unsupported and incomplete.
- An omitted or empty patch is `missing`. A patch that does not match its hunk headers, or GitHub's addition and deletion counts, is `invalid`. Neither case is reported as a complete analysis. A partial file list is not returned: if a next page remains after 30 pages of 100 files, the request throws.
- Content larger than 1,000,000 bytes, or a GitHub 403 that says the blob is too large, is `oversized` and the pull request is incomplete. A NUL byte in the first 8,000 bytes, or bytes that are not valid UTF-8, is `binary`. Directories, symlinks, and submodules are `unsupported` and are not followed.
- Generated-file detection is a path heuristic (`dist/`, `build/`, `coverage/`, `generated/`, minified files, source maps, and common lockfiles). That flag does not by itself make the diff incomplete.
- The two sides of a file are fetched one after the other. Responses 429, 502, 503, and 504, and a 403 that is a rate limit, retry up to 3 times when the wait is at most 10 seconds. A later failure throws. The result is not marked complete.
- This step does not analyze attention and does not publish a GitHub comment.

## Logical blocks

`createCodeParser()` compares the base and head syntax of each changed file. A changed line is assigned to the smallest structure that contains it. An unchanged loop or condition is not returned merely because it exists. The enclosing function or method is recorded on the block as context.

Supported now:

- TypeScript and JavaScript, including JSX: `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`.
- Functions, methods, classes, conditional branches, loops, returns, and `try` / `catch` / `finally`.
- Arithmetic expressions.
- Heuristic call shapes for database access, `fetch` and `http.request`, validation (`validate`, `safeParse`, `schema.parse`), authorization (`authorize`, `hasPermission`, and the related names), event `publish` / `emit` / `dispatch`, and `transaction` / `beginTransaction`.

These labels are syntax only. They are not attention decisions. Heuristic labels use medium confidence. A syntax error lowers a mapped block to partial status and medium confidence. A missing patch, a language outside the registry, or a change that falls outside every structure is `unknown` with low confidence and no invented range.

Pass `languages` and `ignore` on the parse request to apply the review-focus filters before parsing. Ignored paths are omitted. The foundation pipeline does not read the policy file itself, and it still does not call GitHub.

Limitations:

- Sibling structures of the same kind are paired in source order. Inserting a block above a similar one can shift that pairing.
- A function or method rename is `moved` only when its parameter list and body still match one unmatched counterpart. A rename that also edits the body is reported as a removal plus an addition.
- Comment-only changes that sit outside a structure are unmapped.
- No other languages are built in. Register a `LanguageSyntaxParser` for a new extension.
- This step does not call an LLM and does not publish a review comment.

## Semantic analysis

`createSemanticAnalyzer().assess` reviews each candidate block for a change in behavior. Pass `createLlmProvider(...)` as `provider`. Claude and GPT share that call, so the analysis pipeline does not change when the provider changes.

Build the provider from configuration. `loadConfig()` reads `LLM_PROVIDER`, `LLM_MODEL`, `ANTHROPIC_API_KEY`, and `OPENAI_API_KEY`. Locally those values belong in an untracked `.env`. In GitHub Actions they belong in Actions secrets on a workflow that does not execute untrusted pull request code. `.github/workflows/pr-review-focus.yml` stays unprivileged: it does not receive an LLM secret and it does not call a model. Do not hardcode a key.

```ts
const config = loadConfig();
const provider =
  config.llmProvider === "none"
    ? undefined
    : createLlmProvider({
        provider: config.llmProvider,
        apiKey: config.llmApiKey,
        ...(config.llmModel === undefined ? {} : { model: config.llmModel }),
      });
```

`LLM_PROVIDER=none` leaves `assessBlocks` without a provider, and the call fails closed with `LlmUnavailableError`. The default Claude model is `claude-sonnet-4-5`. The default GPT model is `gpt-4.1`. Set `LLM_MODEL` when the account needs a different id.

The prompt includes the old and new block text, the changed lines, the enclosing symbol and class or method frames, callers, callees, and tests when the caller supplies them, `criticality` from the review-focus policy, and the diff mapping confidence. Repository text is wrapped as untrusted input. Instructions inside source or documentation do not replace the assessment task.

The model must return one JSON object with `blockId`, `behaviorChanged`, `businessImpact` (`unknown`, `none`, `limited`, `significant`, or `critical`), `reviewReason`, `evidence`, `contextRequired`, `confidence` (`low`, `medium`, or `high`), and `uncertaintyReasons`. Zod checks that object. `blockId` must be the candidate that was sent. A malformed response, a timeout, an unavailable provider, or a budget breach throws. Those failures are not rewritten into a low-priority assessment.

`behaviorChanged: false` is a claim that behavior is unchanged only when `confidence` is `high` and `uncertaintyReasons` is empty. A low-confidence answer cannot use `businessImpact: none`. Missing base and head source stays `unknown` with an uncertainty reason, and the model is not called. A truncated excerpt, an unreliable diff mapping, evidence that cites a line outside the block, or a generic code-quality comment also stays explicitly uncertain.

Each request uses a 20 second timeout, at most three attempts, and retries only transient HTTP statuses and timeouts. The input budget is 3,000 estimated tokens and the output budget is 600 tokens. The estimated cost ceiling is $0.05 for one block. Logs record the provider, model, outcome, attempt, and status code. They omit the API key and the source text.

## Prioritization

`createPrioritizer().rank` turns assessed blocks into one validated report. The same inputs produce the same report. Comments are not published from this stage.

The report names `baseSha`, `headSha`, and an `analysisStatus` of `complete`, `partial`, or `unavailable`. Every selected block keeps its block id, the changed-line range, and the logical block range that contains it. A block with no changed lines is excluded. A changed range that does not sit inside the block is excluded rather than given an invented location.

Groups:

| Group                | Summary band | When it is used                                                                                                                                                            |
| -------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `must_review`        | `high`       | A reliable behavior change in authorization, a business calculation, data integrity, or another significant or critical impact. A one-line authorization change qualifies. |
| `review_if_relevant` | `medium`     | A reliable behavior change with narrower impact. A loop is not must-review unless repository criticality marks that change critical.                                       |
| `low_priority`       | `low`        | High-confidence evidence that behavior did not change, such as formatting, a mechanical rename, or routine boilerplate.                                                    |
| `needs_context`      | `medium`     | Missing analysis, low confidence, uncertainty, or an unknown impact. This group is never used to shrink the summary.                                                       |

`displayed` is the summary. It keeps `needs_context` visible at every `minBand`, hides `low_priority` when `minBand` is above `low`, and stops at `maxBlocks`. Blocks that are important enough for the summary but sit past `maxBlocks` are listed in `overflow` and counted. Low-priority blocks that are hidden remain in `groups.lowPriority`.

Deduplication prefers the smallest understandable block when changed ranges overlap. It expands to the enclosing block when that block's assessment requests surrounding context. Overlapping partial ranges are merged, and the report lists the kept id, the absorbed ids, and the duplicate ids.

## Publishing

`createReviewPublisher({ token }).publish` posts the ranked blocks to the pull request through the GitHub REST API. `toReviewFocusReport` maps a prioritization report into the publishing report. The comment is titled **AI Review Focus** and starts with the marker `<!-- review-navigator:summary -->`. A second publish updates that comment. It does not add another summary. Extra copies of the marker are deleted.

The comment lists the base and head SHAs, MUST REVIEW blocks, REVIEW IF RELEVANT blocks, a collapsed low-priority section, and NEEDS CONTEXT blocks. Each block shows its symbol, file, changed line range, a link to that range, and the review reason. The comment states that priorities indicate review importance, not verified defects.

MUST REVIEW blocks also get an inline review comment on the first changed line, using `RIGHT` for the head side and `LEFT` for the base side. The comment is tied to the head SHA. When the logical block is wider than the changed range, the inline comment stays on the changed line and links to the wider range. GitHub rejects a line that is not in the diff with status 422. That block stays in the summary, and the publisher does not try another line. Inline comments carry `<!-- review-navigator:inline ... -->`. A later publish updates a comment that is still on the same line and removes comments for blocks that are no longer must-review.

The publisher does not approve, request changes, or merge. Calls that return 401 or 403 fail with `github_request_failed`. Rate limits use the existing bounded retry. `createFoundationPipeline()` does not publish until the caller passes a publisher.

`.github/workflows/pr-review-focus.yml` stays read-only and does not publish. `.github/workflows/publish-review-focus.yml` is the trusted workflow. Dispatch it from the default branch. It checks out that ref, not the pull request head, and it does not run pull request code. Its permissions are `contents: read` and `pull-requests: write`. The write token is present only in the publish step. Set `REVIEW_FOCUS_REPORT` to a JSON report produced by trusted code. `pull_request_target` is not used.

## Security

- Put `GITHUB_TOKEN` in the environment when a caller retrieves a pull request diff. Put `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the environment when semantic analysis calls Claude or GPT.
- Commit `.env.example` with empty placeholders. Do not commit `.env`.
- Do not commit private repository contents or pull request patches.
- `CI` requests `contents: read` only. `PR Review Focus` requests `contents: read` and `pull-requests: read`. That pull request workflow does not get an LLM secret and does not publish.
- `Publish Review Focus` requests `contents: read` and `pull-requests: write`. Dispatch it from the default branch. Do not grant that write permission to a job that runs pull request code.

## Milestones

Ship these in order. Milestones 1–6 and 8 are in the tree. Milestones 7 and 9 are not started.

1. **Foundation and contracts** — Current. Tooling, module boundaries, validated configuration, and fail-closed pipeline stages.
2. **GitHub pull request intake** — Current. Read pull request metadata, paginated changed files, patches, and file contents at the base and head commit SHAs.
3. **Diff model** — Current. Normalize unified diffs into files, hunks, changed line ranges, and base and head source, and mark missing information.
4. **Logical blocks** — Current. Map changed lines in TypeScript and JavaScript onto functions, branches, loops, and the other structures in `LOGICAL_BLOCK_KINDS`.
5. **Attention analysis** — Current. Ask Claude or GPT whether a candidate block changes behavior, validate the JSON, and keep an uncertain result explicit.
6. **Prioritization** — Current. Rank assessed blocks into must-review, review-if-relevant, low-priority, and needs-context groups, and keep overflow visible when the summary budget is full.
7. **LLM explanations** — Not started. Ask Claude or GPT to explain why a selected block deserves attention.
8. **Publication** — Current. Post one AI Review Focus summary on the pull request, update it on later runs, and anchor must-review blocks to changed lines.
9. **GitHub Action** — Not started. Run the pipeline for a pull request and publish the focus report.

## Stack

Node.js, TypeScript in strict mode, npm, GitHub Actions, Zod, Vitest, ESLint, Prettier, the GitHub REST API, and the TypeScript compiler API for logical blocks. Additional languages can register a syntax parser. Semantic analysis and later explanations go through an `LlmProvider` for Claude or GPT. The MVP has no web server, dashboard, or database.
