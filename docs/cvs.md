# CVs: LaTeX, Word & the personal brief

CV Clanker tailors a copy of a CV you upload; it edits the content of that
document rather than generating a new one. The upload can be LaTeX or Word.

You choose the format once per [profile](configuration.md#profiles), at
onboarding. It's fixed for that profile (LaTeX and Word are handled differently
internally), but you can keep multiple profiles.

## LaTeX CVs

Upload a single `.tex`, or a `.zip` containing your main file plus anything it
pulls in with `\input{}` / `\include{}`.

On upload, CV Clanker:

1. **Flattens** all `\input{}`s into one document.
2. **Extracts** a templated `.tex` with placeholders plus a JSON list of the
   editable fields (summary, bullets, skills, dates, and so on).
3. **Checks the round-trip** by recompiling with
   [Tectonic](https://tectonic-typesetting.github.io/), extracting the PDF text
   with `pdftotext`, and diffing it against the original. If the result doesn't
   match, the upload is rejected — there is no partial-acceptance state.

If an upload is rejected, it's usually an unusual macro or a package Tectonic
can't resolve. Compile the `.tex` with Tectonic locally first (if Tectonic can't
build it, CV Clanker can't either), prefer standard packages, and make sure every
`\input{}` file is in the `.zip`.

Tailored LaTeX CVs render to PDF via Tectonic.

## Word (`.docx`) CVs

With a Word profile you download a `.docx`; the PDF is a preview only.

On upload, CV Clanker extracts the text, has the LLM name the tailorable spans
(it doesn't write markup — CV Clanker inserts the markers), and accepts the file
only if the extracted text matches the original exactly and it converts to PDF
via LibreOffice.

Tailoring rewrites the marked spans in place and repackages the `.docx`, so the
downloaded file keeps your original fonts and layout with tailored content. A PDF
preview is generated for the browser.

Note: cover letters are LaTeX only. A Word profile tailors the Word CV, but its
cover letters use the LaTeX substrate — see
[Tailoring](tailoring.md#cover-letters).

## LaTeX or Word?

| | LaTeX | Word |
|---|---|---|
| You download | PDF | `.docx` (plus PDF preview) |
| Best if | You already have a `.tex` résumé | You work in Word / Google Docs and want an editable file to submit |
| Cover letters | LaTeX | LaTeX |
| Upload check | Recompile + `pdftotext` diff | Exact-text match + LibreOffice conversion |

If you don't already have a LaTeX CV, Word is usually simpler.

## The personal brief

The brief is long-form, first-person text describing things a CV doesn't include:
side projects, tools used briefly, context behind a role.

Tailoring draws only on the brief and the job description. With little in the
brief there's little for tailoring to reference; with more, there's more it can
use. It isn't used to invent experience.

Writing one:

- First person and concrete: technologies, scale, outcomes.
- Include what didn't fit on the CV.
- Accuracy and completeness matter more than polish.

CV Clanker can generate a first draft from your CV during onboarding, as a
starting point to edit.

## Locked fields

Fields you don't want rewritten — a name, a specific title, a credential — can be
locked. Locked fields are excluded from every edit proposal, in both tailoring
and the [ghostwriter](tailoring.md#the-ghostwriter-chat-panel).
