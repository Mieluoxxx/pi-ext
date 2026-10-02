/**
 * pi-advisor — standalone Pi extension
 *
 * Registers the `advisor` tool, `/advisor` command, and four lifecycle
 * hooks (session_start restore, before_agent_start strip, model_select
 * re-evaluation, thinking_level_select re-evaluation) that together
 * implement the advisor-strategy pattern, plus the opt-in background
 * completion review (agent_settled).
 *
 * Config persists at ~/.config/rpiv-advisor/advisor.json. Tool name
 * preserved verbatim from rpiv-pi@7525a5d.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	registerAdvisorBeforeAgentStart,
	registerAdvisorCommand,
	registerAdvisorSessionStart,
	registerAdvisorTool,
	registerModelSelectHandler,
	registerThinkingLevelSelectHandler,
} from "./advisor/index.js";

import { registerAdvisorReview } from "./advisor/review.js";
import { registerAdvisorWarming } from "./advisor/warming.js";

export default function (pi: ExtensionAPI) {
	registerAdvisorWarming(pi);
	registerAdvisorReview(pi);
	registerAdvisorTool(pi);
	registerAdvisorCommand(pi);
	registerAdvisorBeforeAgentStart(pi);
	registerModelSelectHandler(pi);
	registerThinkingLevelSelectHandler(pi);
	registerAdvisorSessionStart(pi);
}
