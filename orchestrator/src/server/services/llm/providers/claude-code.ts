import { createProviderStrategy } from "./factory";

export const claudeCodeStrategy = createProviderStrategy({
  provider: "claude_code",
  defaultBaseUrl: "",
  requiresApiKey: false,
  modes: ["none"],
  validationPaths: [],
  buildRequest: () => {
    throw new Error("Claude Code provider does not use HTTP requests.");
  },
  extractText: () => null,
  getValidationUrls: () => [],
});
