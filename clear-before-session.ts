/** Clear the terminal while preserving scrollback, then leave two blank lines before each session. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    // Terminal control sequences are only appropriate for the interactive TUI.
    if (ctx.mode !== "tui" || !process.stdout.isTTY) return;

    execFileSync("clear", ["-x"], { stdio: "inherit" });
    process.stdout.write("\n\n");
  });
}
