/**
 * Give a new Pi session a short, useful name after its first prompt.
 *
 * The name is generated with OpenRouter's openai/gpt-oss-120b model and does
 * not change the model used for the main conversation.
 */
import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { debug, LLMCall } from "./shared/lib.ts";

const NAME_SESSION_SYSTEM_PROMPT = readFileSync(
  new URL("./prompts/name-session.txt", import.meta.url),
  "utf8",
).trim();

const PROVIDER = "openrouter";
const MODEL_ID = "openai/gpt-oss-120b";



function firstPromptAlreadyExists(ctx: ExtensionContext): boolean {
  return ctx.sessionManager.getEntries().some((entry: any) =>
    entry.type === "message" && entry.message?.role === "user",
  );
}

async function nameFromPrompt(
  prompt: string,
  ctx: ExtensionContext,
  setName: (name: string) => void,
): Promise<void> {
  debug(ctx, `requesting a name from ${PROVIDER}/${MODEL_ID}`);
  const name = (await LLMCall(
    ctx,
    { provider: PROVIDER, id: MODEL_ID },
    prompt,
    NAME_SESSION_SYSTEM_PROMPT,
    { maxTokens: 24, temperature: 0.2 },
  ))
    .replace(/[\r\n]+/g, " ")
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (name.length > 60) {
    // Truncate at a word boundary instead of mid-word.
    name = name.slice(0, 61).replace(/\s+\S*$/, "").trim();
  }

  if (!name) {
    debug(ctx, "the naming model returned an empty name");
    return;
  }

  setName(name);
}

export default function (pi: ExtensionAPI) {
  let attempted = false;
  let namingInProgress = false;

  pi.on("session_start", (_event, _ctx) => {
    attempted = false;
    namingInProgress = false;
  });

  pi.on("input", (event, ctx) => {
    if (event.source === "extension" || attempted || namingInProgress) {
      return { action: "continue" as const };
    }
    if (firstPromptAlreadyExists(ctx)) {
      attempted = true;
      return { action: "continue" as const };
    }

    attempted = true;
    namingInProgress = true;
    debug(ctx, "first prompt detected; starting automatic naming");
    void nameFromPrompt(event.text, ctx, (name) => {
      pi.setSessionName(name);
      debug(ctx, `session named: ${name}`);
    })
      .catch((error) => debug(ctx, `naming failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { namingInProgress = false; });

    return { action: "continue" as const };
  });
}
