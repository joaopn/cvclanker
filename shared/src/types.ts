/**
 * Shared types for the CV Clanker orchestrator.
 *
 * Types are organized by domain in the `./types/` subdirectory. With
 * `moduleResolution: "bundler"` tsc prefers this file over the directory
 * barrel, so it must mirror `./types/index.ts` exactly — point at it
 * directly to avoid drift.
 */

export * from "./types/index";
