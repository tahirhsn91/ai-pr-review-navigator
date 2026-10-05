# End-to-end evaluation

This report measures one synthetic pull request.
It does not claim the product is ready to roll out.

## Dataset

- Files: 17
- Labeled regions: 20
- Important regions: 10
- Not-important regions: 7
- Uncertain regions: 3
- Historical pull requests: 0

Labels mean a block deserves human review.
They are not labels for known bugs.
One author assigned them on synthetic fixtures.
No second rater and no historical reviewer labels were used.
Private pull requests were not fetched.

## Model

The stand-in returns a fixed JSON card when the prompt contains a snippet.
Unmatched blocks stay uncertain.
Cards were written from the fixture text, not from the gold label.
This is not a call to Claude or GPT.
Cost uses the rates in src/llm/limits.ts: 3 USD and 15 USD per million tokens.
That cost is an estimate, not an invoice.

## Metrics

- Important-block recall: 10/10 (100.0%)
- Top-five coverage: 5/10 (50.0%)
- Selected-block precision: 10/14 (71.4%)
- Not-important regions deprioritized: 7/7 (100.0%)
- Important regions deprioritized: 0/10 (0.0%)
- Uncertain regions silently deprioritized: 0/3 (0.0%)
- Links checked: 57. Unresolved links: 0.
- Changed-range links: 33. Inaccurate: 1.
- Inaccurate changed-range paths: src/unmapped-fee.ts.
- Duplicate summary comments after 2 publishes: 0.
- Duplicate inline comments: 0.
- Stand-in tokens: 13893 in, 2296 out.
- Estimated stand-in cost: 0.076119 USD.
- Large pull request: displayed 12, must-review 0, needs-context 30, low-priority 30.
- Reviewer-reported time saved: not measured.

Recall counts must-review and review-if-relevant coverage.
needs-context is not a recall hit and is not a silent drop.
Top-five uses the first five displayed blocks, not the whole comment.
Precision divides important overlaps by every selected review block.
Unlabeled and uncertain-only blocks count against precision.
A changed-range link is accurate when every linked line was really changed.
Wider inline context links are checked only to see that the file line exists.
Wall-clock latency is asserted by the test and is not frozen here.

## Label placements

- access-admin: important, renamed-file, must_review
- access-check: important, authorization, must_review
- account-key: important, database-mutation, must_review
- accrue-loop: important, loop-state, review_if_relevant
- billing-charge: important, business-calculation, must_review
- broken-parse: uncertain, parser-failure, needs_context
- charge-expectation: important, test-only, review_if_relevant
- label-rename: not_important, rename, low_priority
- legacy-fee: important, deleted-file, must_review
- mechanical-alpha: not_important, mechanical-refactor, low_priority
- mechanical-beta: not_important, mechanical-refactor, low_priority
- mechanical-gamma: not_important, mechanical-refactor, low_priority
- notes-python: uncertain, unsupported-language, needs_context
- pixels-alias: not_important, type-only, low_priority
- quote-signature: important, api-contract, must_review
- render-loop: important, repeated-operation, review_if_relevant
- spacing-test: not_important, test-only, low_priority
- spacing-whitespace: not_important, formatting, low_priority
- transfer-transaction: important, transaction, must_review
- unmapped-fee: uncertain, missing-context, needs_context

## Selected blocks without an important or not-important label

- src/access.ts must_review src/access.ts#return|openAccount|return#0
- src/transfer.ts must_review src/transfer.ts#database_call|transfer.anonymous|db.update#0
- src/transfer.ts must_review src/transfer.ts#database_call|transfer.anonymous|db.update#1
- src/transfer.ts must_review src/transfer.ts#function|transfer|anonymous#0

## Failure scenarios

- large-pr: 30 mechanical files finished. Must-review 0. Needs context 30. Hidden low-priority 30.
- missing-patch: src/unmapped-fee.ts, whose patch text was withheld, was placed in needs_context.
- missing-source: Neither patch nor source was excluded 1 time(s) and published 0 time(s).
- deleted-file: Deleted src/legacy-fee.ts was placed in must_review.
- renamed-file: Renamed access-check landed in must_review. access-admin landed in must_review.
- pure-rename: A renamed file with identical contents produced 0 review blocks.
- invalid-llm: Invalid model JSON raised AnalysisError. No comment was published.
- provider-timeout: The provider timed out and raised LlmRequestError. No comment was published.
- rate-limit: The publisher received HTTP 429 once, retried, and published one summary.
- missing-permission: HTTP 403 returned GitHubRequestError. The token was redacted.
- stale-head: Publishing stopped before any request because headSha does not match PUBLISH_HEAD_SHA.
- partial-publish: Inline publishing failed after the summary. The retry left 1 summary.

## Security

- fork-workflow: Fork pull requests start only the read-only workflow with blank tokens.
- trusted-publish: Publish checks out github.ref and holds the write token only on that step.
- untrusted-code: A throwing fixture was parsed and assessed without executing the throw.
- privileged-fetch: Foundation fetch remains unimplemented, so private history was not retrieved.

## Limitations

- The dataset is small and synthetic.
- A handful of agreements is not evidence of production quality.
- The stand-in can agree with the author because both read the same fixture.
- Reviewer time saved was not measured.
- Missing patch text is anchored to the whole file, so its line range is wrong.
- A file with no patch and no source is still excluded, because it has no line.
- The stale-head check runs only when PUBLISH_HEAD_SHA is set.
- The product does not poll GitHub for a newer head SHA.
- Metrics were not adjusted to improve these figures.

## Pilot readiness

Pilot readiness: Not ready.

Important-block recall was measured on this fixture before any rollout claim.
The measurement is not a passing score for a pilot.
Reviewer-reported time saved: not measured.
