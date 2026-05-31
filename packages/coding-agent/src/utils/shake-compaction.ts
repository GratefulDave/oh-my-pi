import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import { tinyTitleClient } from "../tiny/title-client";

// Regex to find fenced markdown code blocks (e.g., ```lang ... ```)
const FENCED_CODE_REGEX = /```([a-zA-Z0-9+#-]*)\n([\s\S]*?)\n```/g;

export interface ShakeCompactionResult {
	originalTokens: number;
	newTokens: number;
	elidedCount: number;
}

export async function shakeSession(
	session: AgentSession,
	options: { summary?: boolean } = {},
): Promise<ShakeCompactionResult> {
	const branchEntries = session.sessionManager.getBranch();
	if (branchEntries.length === 0) {
		return { originalTokens: 0, newTokens: 0, elidedCount: 0 };
	}

	logger.debug("shake-compaction: starting shake on session", {
		entryCount: branchEntries.length,
		summary: options.summary,
	});

	let elidedCount = 0;
	const sessionManager = session.sessionManager;

	// Local tiny model to use for summaries (Qwen 1.7B)
	const shakeSummaryModel = session.settings.get("providers.shakeSummaryModel") || "qwen3-1.7b";

	for (const entry of branchEntries) {
		if (entry.type === "message" && entry.message.role === "toolResult" && Array.isArray(entry.message.content)) {
			for (const block of entry.message.content) {
				if (block.type === "text" && block.text.length > 1000) {
					// Elide heavy tool call result
					try {
						const { id, path: artPath } = await sessionManager.allocateArtifactPath("shake");
						if (id && artPath) {
							await Bun.write(artPath, block.text);
							elidedCount++;

							let summaryText = "";
							if (options.summary) {
								const summary = await generateExtractiveSummary(block.text, shakeSummaryModel);
								if (summary) {
									summaryText = ` Summary: ${summary}`;
								}
							}

							block.text = `[Output elided — full content at artifact://${id}.${summaryText}]`;
						}
					} catch (err) {
						logger.debug("shake-compaction: failed to elide toolResult", { err });
					}
				}
			}
		} else if (
			entry.type === "message" &&
			(entry.message.role === "user" || entry.message.role === "assistant") &&
			Array.isArray(entry.message.content)
		) {
			for (const block of entry.message.content) {
				if (block.type === "text" && block.text.length > 1000) {
					// Scan and elide large fenced code blocks inside prose
					FENCED_CODE_REGEX.lastIndex = 0;
					const matchesToReplace: Array<{ matchStr: string; replacement: string }> = [];
					let newText = block.text;
					let matches = FENCED_CODE_REGEX.exec(block.text);
					while (matches !== null) {
						const [matchStr, lang, code] = matches;
						if (code.length > 800) {
							try {
								const { id, path: artPath } = await sessionManager.allocateArtifactPath("shake");
								if (id && artPath) {
									await Bun.write(artPath, matchStr);
									elidedCount++;

									let summaryText = "";
									if (options.summary) {
										const summary = await generateExtractiveSummary(code, shakeSummaryModel);
										if (summary) {
											summaryText = ` Summary: ${summary}`;
										}
									}

									matchesToReplace.push({
										matchStr,
										replacement: `\n[Fenced ${lang || "code"} elided — full content at artifact://${id}.${summaryText}]\n`,
									});
								}
							} catch (err) {
								logger.debug("shake-compaction: failed to elide fenced block", { err });
							}
						}
						matches = FENCED_CODE_REGEX.exec(block.text);
					}

					for (const { matchStr, replacement } of matchesToReplace) {
						newText = newText.replace(matchStr, replacement);
					}
					block.text = newText;
				}
			}
		}
	}

	if (elidedCount > 0) {
		// Persist the updated entries directly into the session file
		await sessionManager.rewriteEntries();
		// Update in-memory session messages
		const sessionContext = session.buildDisplaySessionContext();
		session.agent.replaceMessages(sessionContext.messages);
		logger.debug("shake-compaction: shake completed successfully", { elidedCount });
	}

	return {
		originalTokens: 0,
		newTokens: 0,
		elidedCount,
	};
}

async function generateExtractiveSummary(text: string, modelKey: string): Promise<string | null> {
	try {
		const prompt = `Generate a single 1-line description of what this content is. Do not explain, greet, or repeat. Keep it under 15 words.\n\nContent:\n${text.slice(0, 1500)}\n\nDescription:`;
		const summary = await tinyTitleClient.complete(modelKey, prompt, { maxTokens: 20 });
		return summary ? summary.trim() : null;
	} catch (error) {
		logger.debug("shake-compaction: failed to generate summary with local model", { error });
		return null;
	}
}
