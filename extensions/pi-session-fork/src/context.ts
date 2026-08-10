import {
	buildSessionContext,
	convertToLlm,
	serializeConversation,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

/** The read-only session surface extensions receive. */
export type ReadonlySessionManager = Pick<
	SessionManagerLike,
	"getEntries" | "getLeafId" | "getSessionId"
>;

type SessionManagerLike = {
	getEntries(): SessionEntry[];
	getLeafId(): string | null;
	getSessionId(): string;
};

export interface OutlineSnapshot {
	/** Compaction-aware serialized parent conversation, for reference only. */
	readonly conversation: string;
	/** Model the parent was using, as `provider/model` or undefined. */
	readonly model?: string;
	/** Parent thinking level at snapshot time. */
	readonly thinkingLevel?: string;
	/** Parent session id, for the snapshot header. */
	readonly sessionId?: string;
	readonly cwd: string;
}

/**
 * Builds a read-only, compaction-aware snapshot of the current session.
 * The conversation is serialized as reference text for the outline answer;
 * nothing here is written back into the session.
 */
export function buildOutlineSnapshot(
	sessionManager: ReadonlySessionManager,
	cwd: string,
): OutlineSnapshot {
	const sessionContext = buildSessionContext(
		sessionManager.getEntries(),
		sessionManager.getLeafId(),
	);
	const conversation =
		sessionContext.messages.length === 0
			? ""
			: serializeConversation(convertToLlm(sessionContext.messages));
	return {
		conversation,
		...(sessionContext.model
			? { model: `${sessionContext.model.provider}/${sessionContext.model.modelId}` }
			: {}),
		...(sessionContext.thinkingLevel
			? { thinkingLevel: sessionContext.thinkingLevel }
			: {}),
		sessionId: sessionManager.getSessionId(),
		cwd,
	};
}

/** Builds the prompt handed to the outline model: snapshot + question. */
export function buildOutlinePrompt(
	snapshot: OutlineSnapshot,
	question: string,
): string {
	const header = [
		"# Current session context (read-only snapshot)",
		`- Session: ${snapshot.sessionId ?? "unknown"}`,
		`- Cwd: ${snapshot.cwd}`,
		...(snapshot.model ? [`- Model: ${snapshot.model}`] : []),
		...(snapshot.thinkingLevel ? [`- Thinking: ${snapshot.thinkingLevel}`] : []),
	].join("\n");

	const body = snapshot.conversation
		? `\n\n<parent-conversation>\n${snapshot.conversation}\n</parent-conversation>`
		: "\n\n(No parent conversation yet.)";

	return `${header}${body}

Answer the following question using the parent-conversation as reference context. This is a temporary side question: your answer is shown to the user but NOT added to the session context.

Question: ${question}`;
}
