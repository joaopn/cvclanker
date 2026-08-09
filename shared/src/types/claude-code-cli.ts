/** Status of the Claude Code CLI installation inside the container. */
export type ClaudeCodeCliStatus = {
  /** Version reported by `claude --version`, or null when not installed. */
  installed: string | null;
  /** Latest version on the npm registry, or null when unreachable. */
  latest: string | null;
  /**
   * Version the image was built (and the provider verified) against, from the
   * CLAUDE_CODE_CLI_PINNED env baked by the Dockerfile; null on older images.
   */
  pinned: string | null;
};
