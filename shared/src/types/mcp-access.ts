/**
 * Agent access over MCP. The token itself has no read surface: only the
 * response that creates it carries it, and the server keeps just its digest.
 */

export type McpAccessLevel = "read" | "read_write";

export interface McpAccessState {
  enabled: boolean;
  accessLevel: McpAccessLevel;
  shareBrief: boolean;
  createdAt: string | null;
}

export interface McpAccessSummary extends McpAccessState {
  webLoginEnabled: boolean;
}

export interface McpTokenIssued extends McpAccessSummary {
  token: string;
}

export interface UpdateMcpAccessInput {
  accessLevel?: McpAccessLevel;
  shareBrief?: boolean;
}
