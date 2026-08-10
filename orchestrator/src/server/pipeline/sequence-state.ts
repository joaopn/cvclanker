/**
 * Module state for a multi-profile run sequence, deliberately kept in its own
 * import-free file: `orchestrator.ts` needs to read the active flag (so
 * `getPipelineStatus` stays true in the gap between profiles) while
 * `profile-sequence.ts` needs `runPipeline` from `orchestrator.ts`. Holding the
 * flag here breaks what would otherwise be an import cycle.
 */

let sequenceActive = false;
let sequenceCancelRequested = false;

/**
 * Claim the sequence slot. Compare-and-set on purpose: the caller claims
 * SYNCHRONOUSLY before its first await, so two concurrent requests cannot both
 * see "inactive" across the awaits they need (profile loads, registry load) and
 * both start a chain. A losing caller gets `false` and should reject with 409.
 *
 * The claim is released by `endProfileSequence`, which `runProfileSequence`
 * calls in its `finally` — or by the claimant itself if it fails before
 * starting the sequence.
 */
export function tryBeginProfileSequence(): boolean {
  if (sequenceActive) return false;
  sequenceActive = true;
  // Defensive: a cancel flag can only be set while a sequence is active, but
  // clearing on claim means a stray flag can never make the NEXT chain break
  // on its first iteration and report "cancelled" having run nothing.
  sequenceCancelRequested = false;
  return true;
}

export function endProfileSequence(): void {
  sequenceActive = false;
  sequenceCancelRequested = false;
}

export function isProfileSequenceActive(): boolean {
  return sequenceActive;
}

/**
 * Only meaningful while a sequence is active — the caller (the cancel route)
 * gates on `isProfileSequenceActive()` so a cancel aimed at a plain single run
 * can't strand a flag that nothing would clear.
 */
export function requestProfileSequenceCancel(): void {
  sequenceCancelRequested = true;
}

export function isProfileSequenceCancelRequested(): boolean {
  return sequenceCancelRequested;
}
