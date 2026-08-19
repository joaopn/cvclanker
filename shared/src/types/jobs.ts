import type { ExtractorSourceId } from "../extractors";
import type { CvFieldOverrides } from "./cv-content";
import type { LocationEvidence, LocationMatchResult } from "./location";

export type { LocationEvidenceQuality } from "./location";

export type JobLocationEvidence = LocationEvidence;

export type JobStatus =
  | "discovered" // Inbox: crawled but not picked
  | "selected" // RETIRED: the Selected staging tab was removed; kept in the enum so legacy rows still read/migrate. Reconciled to `discovered` on boot. No new writers.
  | "processing" // Currently generating resume (in the Tailoring tab)
  | "ready" // PDF generated, waiting for user to apply
  | "applied" // Application sent
  | "in_progress" // In process beyond initial application
  | "backlog" // Aged-out of inbox (auto or manual); revivable on repost
  | "stale" // Holding pen for rows the user is considering retiring; manual sweep destination
  | "skipped" // User skipped without applying
  | "closed"; // Application concluded; outcome stored

export const APPLICATION_STAGES = [
  "applied",
  "recruiter_screen",
  "assessment",
  "hiring_manager_screen",
  "technical_interview",
  "onsite",
  "offer",
  "closed",
] as const;

export type ApplicationStage = (typeof APPLICATION_STAGES)[number];

export const STAGE_LABELS: Record<ApplicationStage, string> = {
  applied: "Applied",
  recruiter_screen: "Recruiter Screen",
  assessment: "Assessment",
  hiring_manager_screen: "Team Match",
  technical_interview: "Technical Interview",
  onsite: "Final Round",
  offer: "Offer",
  closed: "Closed",
};

export type StageTransitionTarget = ApplicationStage | "no_change";

export const APPLICATION_OUTCOMES = [
  "rejected",
  "withdrawn",
  "ghosted",
  "duplicated",
  "other",
] as const;

export type JobOutcome = (typeof APPLICATION_OUTCOMES)[number];

export const SUITABILITY_CATEGORIES = [
  "great_fit",
  "very_good_fit",
  "good_fit",
  "bad_fit",
] as const;

export type SuitabilityCategory = (typeof SUITABILITY_CATEGORIES)[number];

export const SUITABILITY_CATEGORY_LABELS: Record<SuitabilityCategory, string> =
  {
    great_fit: "Great fit",
    very_good_fit: "Very good fit",
    good_fit: "Good fit",
    bad_fit: "Bad fit",
  };

/**
 * Rank from "worst" (0) to "best" (3). Used to implement
 * "min category" filtering: a job qualifies when its rank >= threshold rank.
 */
export const SUITABILITY_CATEGORY_RANK: Record<SuitabilityCategory, number> = {
  bad_fit: 0,
  good_fit: 1,
  very_good_fit: 2,
  great_fit: 3,
};

export const APPLICATION_TASK_TYPES = [
  "prep",
  "todo",
  "follow_up",
  "check_status",
] as const;

export type ApplicationTaskType = (typeof APPLICATION_TASK_TYPES)[number];

export const INTERVIEW_TYPES = [
  "recruiter_screen",
  "technical",
  "onsite",
  "panel",
  "behavioral",
  "final",
] as const;

export type InterviewType = (typeof INTERVIEW_TYPES)[number];

export const INTERVIEW_OUTCOMES = [
  "pass",
  "fail",
  "pending",
  "cancelled",
] as const;

export type InterviewOutcome = (typeof INTERVIEW_OUTCOMES)[number];

export interface StageEventMetadata {
  note?: string | null;
  actor?: "system" | "user";
  groupId?: string | null;
  groupLabel?: string | null;
  eventLabel?: string | null;
  externalUrl?: string | null;
  reasonCode?: string | null;
  eventType?: "interview_log" | "status_update" | "note" | null;
}

export interface StageEvent {
  id: string;
  applicationId: string;
  title: string;
  groupId: string | null;
  fromStage: ApplicationStage | null;
  toStage: ApplicationStage;
  occurredAt: number;
  metadata: StageEventMetadata | null;
  outcome: JobOutcome | null;
}

export interface ApplicationTask {
  id: string;
  applicationId: string;
  type: ApplicationTaskType;
  title: string;
  dueDate: number | null;
  isCompleted: boolean;
  notes: string | null;
}

export interface Interview {
  id: string;
  applicationId: string;
  scheduledAt: number;
  durationMins: number | null;
  type: InterviewType;
  outcome: InterviewOutcome | null;
}

export interface JobNote {
  id: string;
  jobId: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Synthetic source id for a marketplace-provider actor instance.
 * Shape: `<providerId>:<instanceId>` (e.g. `apify:7a4c1f2e-...`). The
 * colon is what distinguishes a provider source from a built-in
 * `ExtractorSourceId` literal at the type level.
 */
export type ProviderInstanceSourceId = `${string}:${string}`;

export type JobSource = ExtractorSourceId | ProviderInstanceSourceId;

export interface AppliedDuplicateMatch {
  jobId: string;
  title: string;
  employer: string;
  appliedAt: string;
  score: number;
  titleScore: number;
  employerScore: number;
}

export interface Job {
  id: string;

  // Source / provenance
  source: JobSource;
  sourceJobId: string | null; // External ID (if provided)
  jobUrlDirect: string | null; // Source-provided direct URL (if provided)
  datePosted: string | null; // Source-provided posting date (if provided)

  // From crawler (normalized)
  title: string;
  employer: string;
  employerUrl: string | null;
  jobUrl: string; // Gradcracker listing URL
  applicationLink: string | null; // Actual application URL
  disciplines: string | null;
  deadline: string | null;
  salary: string | null;
  location: string | null;
  locationEvidence: JobLocationEvidence | null;
  locationMatch?: LocationMatchResult | null;
  degreeRequired: string | null;
  starting: string | null;
  jobDescription: string | null;

  // Orchestrator enrichments
  status: JobStatus;
  outcome: JobOutcome | null;
  closedAt: number | null;
  profileId: string | null; // Search Profile whose run first discovered the row; null on manual imports and on everything discovered before attribution shipped
  suitabilityCategory: SuitabilityCategory | null; // AI-generated categorical fit
  suitabilityReason: string | null; // AI explanation
  suitabilityModel: string | null; // Model that produced the stored category; null on rows scored before it was recorded
  suitabilityEffort: string | null; // Reasoning effort the call ran at (claude_code only); null when the provider has none
  tailoredFields: CvFieldOverrides; // Per-field override map; absent ids fall back to the field's original value
  cvFieldLocks: string[]; // Field ids the LLM tailoring + chat accept-edit paths must not modify
  tailoringMatched: string[] | null; // ATS keywords surfaced in tailoredFields
  tailoringSkipped: string[] | null; // JD keywords dropped for lack of evidence
  tailoringFailureReason: string | null; // Last processJob error; null = no recorded failure
  cvDocumentId: string | null; // FK to cv_documents.id; pins which CV was tailored
  pdfPath: string | null; // Canonical filename of the generated PDF (bytes live in job_pdfs); truthiness = "a PDF exists"
  coverLetterDraft: string; // Legacy plain-text draft, kept until the field-overrides path fully replaces it
  coverLetterDocumentId: string | null; // FK to cover_letter_documents.id; null = "use the active doc"
  coverLetterFieldOverrides: CvFieldOverrides; // Per-job cover-letter overrides; body field's value is the textarea state
  coverLetterPdfPath: string | null; // Canonical filename of the rendered cover-letter PDF (bytes live in job_pdfs); truthiness = "a PDF exists"
  interviewPrep: string; // User-generated interview strategy (freeform markdown); "" until generated
  appliedDuplicateMatch?: AppliedDuplicateMatch | null; // Included on detail responses and may be omitted on list responses

  // JobSpy fields (nullable for non-JobSpy sources)
  jobType: string | null;
  salarySource: string | null;
  salaryInterval: string | null;
  salaryMinAmount: number | null;
  salaryMaxAmount: number | null;
  salaryCurrency: string | null;
  isRemote: boolean | null;
  jobLevel: string | null;
  jobFunction: string | null;
  listingType: string | null;
  emails: string | null;
  companyIndustry: string | null;
  companyLogo: string | null;
  companyUrlDirect: string | null;
  companyAddresses: string | null;
  companyNumEmployees: string | null;
  companyRevenue: string | null;
  companyDescription: string | null;
  skills: string | null;
  experienceRange: string | null;
  companyRating: number | null;
  companyReviewsCount: number | null;
  vacancyCount: number | null;
  workFromHomeType: string | null;

  // Repost tracking
  repostedAt: string | null;
  repostCount: number;

  // Timestamps
  discoveredAt: string;
  processedAt: string | null;
  readyAt: string | null;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type JobListItem = Pick<
  Job,
  | "id"
  | "source"
  | "title"
  | "employer"
  | "jobUrl"
  | "applicationLink"
  | "datePosted"
  | "deadline"
  | "salary"
  | "location"
  | "status"
  | "outcome"
  | "closedAt"
  | "profileId"
  | "suitabilityCategory"
  | "tailoringFailureReason"
  | "appliedDuplicateMatch"
  | "jobType"
  | "jobFunction"
  | "salaryMinAmount"
  | "salaryMaxAmount"
  | "salaryCurrency"
  | "repostedAt"
  | "repostCount"
  | "discoveredAt"
  | "readyAt"
  | "appliedAt"
  | "updatedAt"
> & {
  // Human-readable label for `source`, resolved server-side (provider
  // instances → their user-set display name; built-ins → metadata label).
  // Optional so non-list callers / fixtures don't need to supply it.
  sourceLabel?: string;
};

// A cluster of active-triage jobs the board itself lists under one posting id.
export interface DuplicateJobGroup {
  /** `<board>:<id>` — globally unique, and what the modal keys its keeper on. */
  key: string;
  title: string; // representative (first member's) title
  employer: string; // representative (first member's) employer
  jobs: JobListItem[];
  /**
   * False when the group's rows disagree about the job title. A board id is
   * strong evidence but not perfect — measured, 39 of 823 id clusters carry
   * more than one distinct title — so those stay reviewable one at a time but
   * are excluded from any bulk close, where a wrong call multiplies.
   */
  bulkSafe: boolean;
}

export interface DuplicateJobGroupsResponse {
  groups: DuplicateJobGroup[];
}

export interface CreateJobInput {
  source: JobSource;
  /**
   * Search Profile that discovered this row. Stamped by the import step from
   * the running profile; absent on manual imports. Written on INSERT only —
   * a URL collision leaves the existing row's attribution alone, so a job
   * keeps the profile that found it first.
   */
  profileId?: string | null;
  title: string;
  employer: string;
  employerUrl?: string;
  jobUrl: string;
  applicationLink?: string;
  disciplines?: string;
  deadline?: string;
  salary?: string;
  location?: string;
  locationEvidence?: JobLocationEvidence;
  degreeRequired?: string;
  starting?: string;
  jobDescription?: string;

  // JobSpy fields (optional)
  sourceJobId?: string;
  jobUrlDirect?: string;
  datePosted?: string;
  jobType?: string;
  salarySource?: string;
  salaryInterval?: string;
  salaryMinAmount?: number;
  salaryMaxAmount?: number;
  salaryCurrency?: string;
  isRemote?: boolean;
  jobLevel?: string;
  jobFunction?: string;
  listingType?: string;
  emails?: string;
  companyIndustry?: string;
  companyLogo?: string;
  companyUrlDirect?: string;
  companyAddresses?: string;
  companyNumEmployees?: string;
  companyRevenue?: string;
  companyDescription?: string;
  skills?: string;
  experienceRange?: string;
  companyRating?: number;
  companyReviewsCount?: number;
  vacancyCount?: number;
  workFromHomeType?: string;
}

export interface ManualJobDraft {
  title?: string;
  employer?: string;
  jobUrl?: string;
  applicationLink?: string;
  location?: string;
  salary?: string;
  deadline?: string;
  jobDescription?: string;
  jobType?: string;
  jobLevel?: string;
  jobFunction?: string;
  disciplines?: string;
  degreeRequired?: string;
  starting?: string;
}

export interface ManualJobInferenceUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  totalMillions: number | null;
}

export interface ManualJobInferenceResponse {
  job: ManualJobDraft;
  warning?: string | null;
  usage?: ManualJobInferenceUsage | null;
}

export interface ManualJobFetchResponse {
  content: string;
  url: string;
}

export interface UpdateJobInput {
  title?: string;
  employer?: string;
  jobUrl?: string;
  applicationLink?: string | null;
  location?: string | null;
  salary?: string | null;
  deadline?: string | null;
  status?: JobStatus;
  outcome?: JobOutcome | null;
  closedAt?: number | null;
  jobDescription?: string | null;
  locationEvidence?: JobLocationEvidence | null;
  suitabilityCategory?: SuitabilityCategory | null;
  // Nullable so a score can be CLEARED, not just overwritten — the column has
  // always been nullable, only this input type was narrower.
  suitabilityReason?: string | null;
  suitabilityModel?: string | null;
  suitabilityEffort?: string | null;
  tailoredFields?: CvFieldOverrides;
  cvFieldLocks?: string[];
  tailoringMatched?: string[] | null;
  tailoringSkipped?: string[] | null;
  tailoringFailureReason?: string | null;
  cvDocumentId?: string | null;
  pdfPath?: string;
  coverLetterDraft?: string;
  coverLetterDocumentId?: string | null;
  coverLetterFieldOverrides?: CvFieldOverrides;
  coverLetterPdfPath?: string | null;
  interviewPrep?: string;
  readyAt?: string;
  appliedAt?: string;
}

export interface CreateJobNoteInput {
  title: string;
  content: string;
}

export interface UpdateJobNoteInput {
  title: string;
  content: string;
}
