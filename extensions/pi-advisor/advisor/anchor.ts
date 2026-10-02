/**
 * anchor — the persisted trim boundary.
 *
 * When a cold request exceeds the context budget the ledger drops its oldest
 * executor activity. That decision must be STICKY: re-deriving it per call
 * would pick a slightly different boundary each time as the branch grows, and
 * every shift rewrites the head of the prompt, so no two consultations would
 * ever share a cached prefix.
 *
 * An anchor names a durable session entry, never an offset into a growing list.
 * It is scoped to the compaction/branch-summary boundary it was written under:
 * after a compaction the branch is a different document, so an older anchor no
 * longer describes it and is discarded rather than reused.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const ADVISOR_ANCHOR_ENTRY = "advisor-context-anchor";

export interface AdvisorAnchor {
	/** Session entry the retained span starts at. */
	entryId: string;
	/** Latest compaction/branch_summary id when the anchor was written. */
	boundaryId: string | null;
}

/** Id of the newest summary boundary on this branch, or null when there is none. */
export function advisorAnchorBoundary(branch: readonly SessionEntry[]): string | null {
	let boundaryId: string | null = null;
	for (const entry of branch) {
		if (entry.type === "compaction" || entry.type === "branch_summary") boundaryId = entry.id;
	}
	return boundaryId;
}

/**
 * The saved anchor, if one applies to this branch.
 *
 * Requires both that it was written under the current boundary and that its
 * target entry is still present — a `/fork` or tree navigation can move the leaf
 * onto a path that never contained it.
 */
export function advisorSavedAnchor(
	branch: readonly SessionEntry[],
	boundaryId: string | null,
): AdvisorAnchor | undefined {
	let anchor: AdvisorAnchor | undefined;
	for (const entry of branch) {
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			// A boundary invalidates anything anchored before it.
			anchor = undefined;
			continue;
		}
		if (entry.type !== "custom" || entry.customType !== ADVISOR_ANCHOR_ENTRY) continue;
		const saved = entry.data as AdvisorAnchor | undefined;
		if (saved?.boundaryId === boundaryId && typeof saved.entryId === "string") anchor = saved;
	}
	if (!anchor) return undefined;
	return branch.some((entry) => entry.id === anchor?.entryId) ? anchor : undefined;
}
