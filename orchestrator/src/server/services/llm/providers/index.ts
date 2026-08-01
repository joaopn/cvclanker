import type { LlmProvider, ProviderStrategy } from "../types";
import { claudeCodeStrategy } from "./claude-code";
import { codexStrategy } from "./codex";
import { geminiStrategy } from "./gemini";
import { lmStudioStrategy } from "./lmstudio";
import { ollamaStrategy } from "./ollama";
import { openAiStrategy } from "./openai";
import { openAiCompatibleStrategy } from "./openai-compatible";
import { openRouterStrategy } from "./openrouter";

export const strategies: Record<LlmProvider, ProviderStrategy> = {
  openrouter: openRouterStrategy,
  lmstudio: lmStudioStrategy,
  ollama: ollamaStrategy,
  openai: openAiStrategy,
  openai_compatible: openAiCompatibleStrategy,
  gemini: geminiStrategy,
  codex: codexStrategy,
  claude_code: claudeCodeStrategy,
};
