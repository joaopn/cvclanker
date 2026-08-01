import type { StepId, ValidationState } from "./types";

export const EMPTY_VALIDATION_STATE: ValidationState = {
  valid: false,
  message: null,
  checked: false,
  hydrated: false,
};

export const STEP_COPY: Record<
  StepId,
  {
    eyebrow: string;
    title: string;
    description: string;
  }
> = {
  llm: {
    eyebrow: "Step 1",
    title: "Choose the LLM connection CV Clanker should use.",
    description:
      "Pick the provider, confirm the endpoint, and validate the credentials this workspace will use for scoring and tailoring.",
  },
  cvformat: {
    eyebrow: "Step 2",
    title: "Pick the format your CV is written in.",
    description:
      "CV Clanker tailors your CV in the format you already work in — LaTeX or Word. This choice is fixed for this user profile: everything downstream (uploads, tailoring, the files you download) follows it. To work in the other format later, create a new user profile.",
  },
  cv: {
    eyebrow: "Step 3",
    title: "Upload your CV.",
    description:
      "Drop your CV — the server checks it, then extracts the spans that per-job tailoring can rewrite. The personal brief drafted from your CV is what powers per-job tailoring; you can paste in extra context (side projects, tools you've used in passing) before continuing.",
  },
  searchprofile: {
    eyebrow: "Step 4",
    title: "Set up what CV Clanker searches for.",
    description:
      "The job titles to search for, and where. Titles are drafted from your CV — edit them until they describe the roles you actually want next.",
  },
  sources: {
    eyebrow: "Step 5",
    title: "Choose the job boards to search.",
    description:
      "The built-in boards are free and all on by default; turn off any you don't want. Apify actors are optional, need your own paid Apify account, and any actor you add here will run — and spend credits — on your next search. You can change all of this later on the Sources page.",
  },
  finalize: {
    eyebrow: "Step 6",
    title: "Finish setting up.",
    description:
      "Two last things. Add a username and password so only signed-in users can reach the protected parts of CV Clanker — or skip it and set it up later in Settings. Then pick the theme you want to work in; it applies immediately and is stored on this device.",
  },
};
