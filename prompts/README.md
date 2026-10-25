# Prompts

Every LLM prompt the server sends is a YAML document. The files in this
directory are the **seeds/defaults**: they are baked into the image, and on
every boot the server syncs them into the `prompts` DB table, which holds the
**live** copies the app actually uses.

Seeding rules per prompt, per boot:

- New file → inserted (live content = default).
- File changed in a newer image → the stored default refreshes; if you never
  edited that prompt, the live content follows automatically. If you edited
  it, your text is kept and only the default updates — "Reset to default"
  brings them back together.
- Editing a file on the host does nothing at runtime anymore (there is no
  bind mount); edit the live copy through the API (`GET/PUT
  /api/prompts/<name>`, `POST /api/prompts/<name>/reset`; fragments via
  `/api/prompts/fragments/<name>`) or the Settings → Prompts panel.

## File layout

```
prompts/
  README.md                       # this file
  cover-letter-generate.yaml      # draft cover-letter field values for a JD
  coverletter-template-extract.yaml  # extract template+fields from an uploaded cover letter
  cv-adjust.yaml                  # tailor CV field values to a JD (ATS pass)
  cv-generate-brief.yaml          # generate the personal brief from a CV
  cv-template-extract.yaml        # extract template+fields from an uploaded CV
  ghostwriter-system.yaml         # per-job ghostwriter chat system prompt
  interview-qa-generate.yaml      # interview strategy + Q&A for a job
  job-fetch-from-url.yaml         # extract structured job fields from raw HTML
  job-fetch-selectors.yaml        # infer CSS selectors for a job page
  job-score.yaml                  # candidate-fit scoring
  onboarding-search-terms.yaml    # suggest search terms from the resume
  fragments/
    cv-format-docx.yaml           # CV-format rules for a Word (.docx) profile
    cv-format-latex.yaml          # CV-format rules for a LaTeX profile
    output-language.yaml          # partial: "always respond in <lang>"
    writing-style.yaml            # partial: tone / formality / constraints
```

## YAML schema

```yaml
name: <prompt-id>            # filename minus .yaml
description: |
  Free-text description shown in the Settings → Prompts panel.
variables:                   # documentation only; not enforced
  - name: <var-name>
    description: <free text>
model:                       # optional model hints; loader returns to caller
  temperature: 0.2
  maxOutputTokens: 16000
  preferStructuredOutput: true
system: |                    # system message; empty string when unused
  ...
user: |                      # user message; empty string when unused
  ...
```

Fragment files in `prompts/fragments/` use a single field instead:

```yaml
name: <fragment-id>
description: ...
template: |
  ...partial body with {{var}} interpolations...
```

Saves through the API validate structure (YAML parses, schema accepts — the
schema is strict, unknown keys are rejected — and every referenced
`{{> partial}}` exists). `{{var}}` names are deliberately NOT validated at
save time: a wrong variable fails loudly at the consuming call, and Reset
recovers.

## Interpolation

- `{{var}}` — Mustache-style variable. Empty string is a valid value;
  undefined throws.
- `{{> partial}}` — splice a fragment in place. The loader looks up
  `fragments/<partial>` first and falls back to `<partial>`. Resolution is
  one level deep — partials cannot reference other partials.

No HTML escaping (LLM input doesn't need it).

## Available variables

These are auto-injected by the loader and can be overridden via the explicit
`vars` arg passed to `loadPrompt()`:

| name             | populated by                                          |
|------------------|-------------------------------------------------------|
| `appVersion`     | orchestrator/package.json                              |
| `outputLanguage` | call sites pass this from `resolveWritingOutputLanguage` |
| `writingStyle`   | call sites pass this from `getWritingStyle`              |

Per-prompt variables are documented in each YAML's `variables` block.

## The CV format note

The CV substrate is LaTeX or Word (`.docx`), fixed per User Profile. The two
prompts that rewrite CV field values — `cv-adjust` and `ghostwriter-system` —
must therefore speak the right format: LaTeX values keep their commands and
escapes, Word values are plain text and would show a stray `\&` literally.

Rather than two copies of each prompt, the server renders the matching
fragment (`fragments/cv-format-latex` or `fragments/cv-format-docx`) at call
time and passes the text in as `{{cvFormatNote}}`. `services/cv/cv-format-note.ts`
owns that mapping; tune either format's rules by editing its fragment.

Three consequences worth knowing:

- `{{cvFormatNote}}` is supplied **only** to those two prompts. Referencing it
  from any other prompt throws at render time (variables are call-time-checked).
- The format fragments are rendered **on their own**, so — unlike
  `writing-style.yaml`, which is spliced into a host prompt and can use that
  prompt's variables — they only have the loader defaults (`appVersion`,
  `outputLanguage`, `writingStyle`). Putting `{{tone}}` in one of them saves
  cleanly and then fails every tailoring call until you Reset it.
- If you have **edited** `cv-adjust` or `ghostwriter-system`, your copy is kept
  as-is and does not gain the `{{cvFormatNote}}` placeholder — the extra
  variable is silently ignored, so nothing breaks, but a Word profile keeps
  getting LaTeX-flavoured instructions. "Reset to default" picks the note up.

## Caching and reload

Edits propagate on the next LLM call automatically — the loader re-parses a
prompt whenever its row's `updated_at` changes. `POST /api/prompts/reload`
(the panel's Reload button) survives as a forced revalidation: reloading a
named prompt surfaces a broken row as an error immediately instead of at the
next pipeline run.

## Editing tips

- LaTeX-friendly: nothing in the loader escapes braces, so writing
  `\section{foo}` in a prompt works.
- If you remove a `{{required}}` variable from a prompt and the corresponding
  call site still passes it, the loader silently ignores the extra.
- If the call site stops passing a variable but the YAML still references it,
  `loadPrompt()` throws with a list of declared-vs-provided vars.
