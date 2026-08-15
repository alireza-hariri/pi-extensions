import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

// Pi calls this setting the thinking level. The commands below intentionally
// support both spellings: /variant (correct) and /varient (as requested).
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof LEVELS)[number];

const completions: AutocompleteItem[] = LEVELS.map((level) => ({
  value: level,
  label: level,
}));

function parseLevel(args: string): ThinkingLevel | undefined {
  const value = args.trim().toLowerCase();
  return (LEVELS as readonly string[]).includes(value)
    ? (value as ThinkingLevel)
    : undefined;
}

export default function (pi: ExtensionAPI) {
  const setLevel = async (args: string, ctx: ExtensionCommandContext) => {
    let level = parseLevel(args);

    if (!args.trim()) {
      if (!ctx.hasUI) {
        ctx.ui.notify("Usage: /effort <off|minimal|low|medium|high|xhigh|max>", "warning");
        return;
      }

      const selected = await ctx.ui.select(
        "Select thinking level",
        LEVELS.map((value) => `${value}${value === pi.getThinkingLevel() ? " (current)" : ""}`),
      );
      if (selected === undefined) return;
      level = selected.split(" ")[0] as ThinkingLevel;
    }

    if (!level) {
      ctx.ui.notify(
        `Unknown thinking level. Choose one of: ${LEVELS.join(", ")}`,
        "error",
      );
      return;
    }

    pi.setThinkingLevel(level);
    ctx.ui.notify(`Thinking level: ${pi.getThinkingLevel()}`, "info");
  };

  const options = {
    description: "Select the model thinking level",
    getArgumentCompletions: (prefix: string) =>
      completions.filter((item) => item.value.startsWith(prefix.toLowerCase())),
    handler: setLevel,
  };

  pi.registerCommand("effort", options);
  pi.registerCommand("variant", options);
}
