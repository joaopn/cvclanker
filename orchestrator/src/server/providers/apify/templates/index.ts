import type { ProviderActorTemplate } from "../../types";
import { cheapScraperLinkedinTemplate } from "./cheap-scraper-linkedin";
import { linkedinJobsScraperTemplate } from "./linkedin-jobs-scraper";
import { valigLinkedinTemplate } from "./valig-linkedin";

export const APIFY_TEMPLATES: readonly ProviderActorTemplate[] = [
  linkedinJobsScraperTemplate,
  cheapScraperLinkedinTemplate,
  valigLinkedinTemplate,
];

export function findApifyTemplate(
  id: string,
): ProviderActorTemplate | undefined {
  return APIFY_TEMPLATES.find((template) => template.id === id);
}
