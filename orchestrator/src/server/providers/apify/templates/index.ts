import type { ProviderActorTemplate } from "../../types";
import { cheapScraperLinkedinTemplate } from "./cheap-scraper-linkedin";
import { linkedinJobsScraperTemplate } from "./linkedin-jobs-scraper";

export const APIFY_TEMPLATES: readonly ProviderActorTemplate[] = [
  linkedinJobsScraperTemplate,
  cheapScraperLinkedinTemplate,
];

export function findApifyTemplate(
  id: string,
): ProviderActorTemplate | undefined {
  return APIFY_TEMPLATES.find((template) => template.id === id);
}
