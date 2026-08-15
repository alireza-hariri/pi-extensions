import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

/** Export the most recent assistant response, then exit pi. */
export default function (pi: ExtensionAPI) {
	pi.registerFlag("result-path", {
		description: "Save the final assistant response to this file and exit",
		type: "string",
	});

	function defaultPath(): string {
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		return `exported-result-${timestamp}.md`;
	}

	function filePath(destination: string, ctx: ExtensionContext): string {
		const expanded = destination === "~"
			? homedir()
			: destination.startsWith("~/")
				? join(homedir(), destination.slice(2))
				: destination;
		return isAbsolute(expanded) ? expanded : resolve(ctx.cwd, expanded);
	}

	async function exportResult(destination: string, ctx: ExtensionContext): Promise<boolean> {
		// getBranch() is the active branch, so responses from abandoned branches
		// are not accidentally exported.
		const entry = [...ctx.sessionManager.getBranch()]
			.reverse()
			.find((candidate) => candidate.type === "message" && candidate.message.role === "assistant");

		if (!entry || entry.type !== "message" || entry.message.role !== "assistant") {
			process.stderr.write("/export-result: no LLM response found\n");
			return false;
		}

		const result = Array.isArray(entry.message.content)
			? entry.message.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join("")
			: entry.message.content;

		const outputPath = filePath(destination, ctx);
		await mkdir(dirname(outputPath), { recursive: true });
		await writeFile(outputPath, result, "utf8");
		return true;
	}

	pi.registerCommand("export-result", {
		description: "Export the last LLM response to a file, then exit pi",
		handler: async (args, ctx) => {
			const destination = args.trim() || defaultPath();
			if (await exportResult(destination, ctx)) {
				ctx.shutdown();
			}
		},
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const destination = pi.getFlag("result-path");
		if (typeof destination !== "string" || !destination.trim()) return;

		if (await exportResult(destination.trim(), ctx)) {
			ctx.shutdown();
		}
	});
}
