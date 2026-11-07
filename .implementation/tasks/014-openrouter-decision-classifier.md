# 014 — Built-in classifier (OpenRouter decision API)

**Goal:** an AI-powered classifier as a built-in option for per-line
attention marking — no user script required. Same customisability as the
chapter analyser (per-task config keys, blocking calls, degrade-don't-fail).
Out of the box it speaks **OpenRouter's decision-model API**
(`/api/alpha/decisions`), with typesafe's **jev** model
(`typesafe/jev-1.14`) supported out of the box — jev is a model on that API,
not the API itself. Mark names **and** their criteria are user-configurable
(`classifier.criteria`: keys are mark names, values the criteria
descriptions). Fires at every chapter rebuild — it *is* the classifier, not
a refine pass; the expansion-time `tasks.classify` LLM refine (011) is
untouched and composes.

**Deliverable/acceptance** (spec §21 M5.2): openrouter backend + key config
→ per-line AI marks at session creation with user-chosen mark
names/criteria; missing key or HTTP failure → rules fallback (or cleared
with `fallback:false`); run logged to `classifier.log`; `debug-classify`
prints the HTTP transcript; existing exec-hook configs behave exactly as
before.

Spec: §16.1 (config keys), §16.5 (classifier pass, both backends), §9.3
(`markSource: "custom"` covers both). Full implementation plan:
`tmp/plans/builtin-classifier/plan.md` (condensed:
`.implementation/plans/014-openrouter-decision-classifier.md`).

**Done** (`src/decisions.ts` + built-in branch in `loadClassifierConfig` /
`applyClassifier`; `classifier.builtin: "openrouter"`; response envelope
probed live: `answers[<qKey>].choice`; apiKey resolution classifier → env →
llm defaults; renamed from the original jev-named backend — the API belongs
to OpenRouter, jev is just a model).
