import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { notFound } from "@infra/errors";
import { db } from "@server/db/index";
import {
  deleteRuntimeSecrets,
  getRuntimeSecretRecord,
  upsertRuntimeSecret,
} from "@server/repositories/runtime-secrets";
import type { McpAccessState, UpdateMcpAccessInput } from "@shared/types";

const TOKEN_DIGEST_KEY = "mcp_token_sha256";
const ACCESS_LEVEL_KEY = "mcp_access_level";
const SHARE_BRIEF_KEY = "mcp_share_brief";
const MCP_KEYS = [TOKEN_DIGEST_KEY, ACCESS_LEVEL_KEY, SHARE_BRIEF_KEY] as const;

const TOKEN_PREFIX = "cvc_";

type Executor = Parameters<typeof getRuntimeSecretRecord>[1];

function sha256(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function readState(executor?: Executor): McpAccessState {
  const token = getRuntimeSecretRecord(TOKEN_DIGEST_KEY, executor);
  const accessLevel = getRuntimeSecretRecord(ACCESS_LEVEL_KEY, executor);
  const shareBrief = getRuntimeSecretRecord(SHARE_BRIEF_KEY, executor);
  return {
    enabled: token !== null,
    accessLevel: accessLevel?.value === "read_write" ? "read_write" : "read",
    shareBrief: shareBrief?.value === "true",
    createdAt: token?.createdAt ?? null,
  };
}

/**
 * Replaces any existing token and resets its switches to read-only with the
 * brief withheld. The returned token is never stored and cannot be read again.
 */
export function generateMcpToken(): string {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const digest = sha256(token).toString("hex");
  db.transaction((tx) => {
    upsertRuntimeSecret(TOKEN_DIGEST_KEY, digest, tx);
    upsertRuntimeSecret(ACCESS_LEVEL_KEY, "read", tx);
    upsertRuntimeSecret(SHARE_BRIEF_KEY, "false", tx);
  });
  return token;
}

export function revokeMcpToken(): void {
  db.transaction((tx) => {
    deleteRuntimeSecrets(MCP_KEYS, tx);
  });
}

export function getMcpAccessState(): McpAccessState {
  return readState();
}

export function updateMcpAccess(input: UpdateMcpAccessInput): McpAccessState {
  return db.transaction((tx) => {
    if (getRuntimeSecretRecord(TOKEN_DIGEST_KEY, tx) === null) {
      throw notFound("No agent token has been generated");
    }
    if (input.accessLevel !== undefined) {
      upsertRuntimeSecret(ACCESS_LEVEL_KEY, input.accessLevel, tx);
    }
    if (input.shareBrief !== undefined) {
      upsertRuntimeSecret(SHARE_BRIEF_KEY, String(input.shareBrief), tx);
    }
    return readState(tx);
  });
}

/** The access the presented token grants, or null when it is not the token. */
export function verifyMcpToken(presented: string): McpAccessState | null {
  const stored = getRuntimeSecretRecord(TOKEN_DIGEST_KEY);
  if (stored === null) return null;
  const expected = Buffer.from(stored.value, "hex");
  const actual = sha256(presented);
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;
  return readState();
}
