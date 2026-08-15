import { createLocalBashOperations, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/**
 * Returns true when the text after @ looks like a filesystem path.
 *
 * A bare name is treated as a path only when it exists in the command's cwd;
 * slash-containing and extension-bearing names are accepted even when they
 * do not exist yet (for example, a path passed to mkdir or touch).
 */
function looksLikePath(value: string, cwd: string): boolean {
  const path = value.replace(/[.,;:!?]+$/, "");
  if (!path) return false;

  return (
    isAbsolute(path) ||
    path.startsWith("~/") ||
    path.startsWith("./") ||
    path.startsWith("../") ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.includes("/") ||
    path.includes("\\") ||
    /(^|[\\/])[^\\/]+\.[^\\/]+$/.test(path) ||
    existsSync(resolve(cwd, path))
  );
}

/** Remove the @ marker from path arguments such as @src/index.ts or @/tmp/x. */
export function stripAtBeforePaths(command: string, cwd: string): string {
  let output = "";

  for (let i = 0; i < command.length; i++) {
    const character = command[i];
    if (character !== "@") {
      output += character;
      continue;
    }

    const previous = command[i - 1];
    const isEscaped = previous === "\\";
    const isTokenStart = i === 0 || /[\s"'`=(:,[{|;&<>]/.test(previous ?? "");

    if (isEscaped || !isTokenStart) {
      output += character;
      continue;
    }

    // If @ follows an opening quote, allow spaces until that quote closes.
    const quote = previous === "'" || previous === '"' || previous === "`" ? previous : undefined;
    let end = i + 1;
    if (quote) {
      const closingQuote = command.indexOf(quote, end);
      end = closingQuote === -1 ? command.length : closingQuote;
    } else {
      while (end < command.length && !/[\s|;&<>()[\]{}'"`]/.test(command[end])) end++;
    }

    // Also support an @ immediately before a quoted path, e.g.
    // @"./path with spaces.txt".
    if (command[i + 1] === "'" || command[i + 1] === '"' || command[i + 1] === "`") {
      const quoted = command[i + 1];
      const closingQuote = command.indexOf(quoted, i + 2);
      const candidate = command.slice(i + 2, closingQuote === -1 ? command.length : closingQuote);
      if (looksLikePath(candidate, cwd)) {
        continue;
      }
    } else {
      const candidate = command.slice(i + 1, end);
      if (looksLikePath(candidate, cwd)) {
        // Do not copy the @. The next loop iteration copies the path itself.
        continue;
      }
    }

    output += character;
  }

  return output;
}

export default function (pi: ExtensionAPI) {
  const localBash = createLocalBashOperations();

  pi.on("user_bash", (event) => ({
    operations: {
      exec(command, cwd, options) {
        return localBash.exec(stripAtBeforePaths(command, cwd), cwd, options);
      },
    },
  }));
}
