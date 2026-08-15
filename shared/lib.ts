import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";



const DEBUG = false;


export function debug(ctx: ExtensionContext, message: string): void {
  if (DEBUG) ctx.ui.setWidget("debug", [`[debug]: ${message}`]);
}

export interface LLMModelRef {
  provider: string;
  id: string;
}

export interface LLMCallOptions {
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

/**
 * Call a model through the OpenAI-compatible chat completions API.
 *
 * The model must come from the current model registry (or be a provider/model
 * string), so authentication is resolved in the same way as Pi's providers.
 * The provider URL is selected through getBaseUrl(), including the VPN route.
 */
export async function LLMCall(
  ctx: ExtensionContext,
  model: LLMModelRef | string,
  prompt: string,
  sysPrompt?: string,
  options: LLMCallOptions = {},
): Promise<string> {
  const modelRef = typeof model === "string"
    ? parseModelRef(model)
    : model;
  const registeredModel = ctx.modelRegistry.find(modelRef.provider, modelRef.id);

  if (!registeredModel) {
    throw new Error(`model ${modelRef.provider}/${modelRef.id} was not found`);
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(registeredModel);
  if (!auth.ok) {
    throw new Error(auth.error);
  }
  if (!auth.apiKey) {
    throw new Error(`no API key for ${modelRef.provider}/${modelRef.id}`);
  }

  const baseUrl = await getBaseUrl(modelRef.provider);
  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (sysPrompt?.trim()) {
    messages.push({ role: "system", content: sysPrompt });
  }
  messages.push({ role: "user", content: prompt });

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${auth.apiKey}`,
      ...(auth.headers ?? {}),
    },
    body: JSON.stringify({
      model: modelRef.id,
      messages,
      max_tokens: options.maxTokens ?? 1024,
      temperature: options.temperature ?? 0.2,
    }),
    signal: options.signal,
  });

  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
  }

  return payload.choices?.[0]?.message?.content ?? "";
}

function parseModelRef(model: string): LLMModelRef {
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) {
    throw new Error(`model must be in provider/model format: ${model}`);
  }
  return {
    provider: model.slice(0, separator),
    id: model.slice(separator + 1),
  };
}

/** Canonical API endpoints used by Pi's built-in providers. */
export const PROVIDER_BASE_URLS = {
  anthropic: "https://api.anthropic.com",
  cerebras: "https://api.cerebras.ai/v1",
  deepseek: "https://api.deepseek.com",
  fireworks: "https://api.fireworks.ai/inference",
  google: "https://generativelanguage.googleapis.com/v1beta",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai",
  moonshotai: "https://api.moonshot.ai/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  together: "https://api.together.ai/v1",
  xai: "https://api.x.ai/v1",
  zai: "https://api.z.ai/api/coding/paas/v4",
} as const;

type KnownProvider = keyof typeof PROVIDER_BASE_URLS;

/** All providers are exposed by the VPN proxy under their provider name. */
export const LLM_PROXY_URL = "https://llm-proxy.open8.ir";

/**
 * Return the provider endpoint appropriate for the current route.
 *
 * Outside the VPN, providers use their normal public API endpoint. When the
 * route uses a VPN, requests go through the shared provider proxy instead.
 */
export async function getBaseUrl(provider: string): Promise<string> {
  const name = provider.trim().toLowerCase() as KnownProvider;
  const baseUrl = PROVIDER_BASE_URLS[name];
  if (!baseUrl) throw new Error(`Unknown provider: ${provider}`);
  const { vpn } = await routeUsesVpn();
  return vpn ? baseUrl : `${LLM_PROXY_URL}/${name}`;

  // try {
  // } catch {
  //   // A failed route check must not send traffic through the proxy.
  //   return baseUrl;
  // }
}

const execFileAsync = promisify(execFile);
const VPN_ROUTE_CACHE_TTL_MS = 500;
const routeCache = new Map<string, {
  result: { vpn: boolean; dev: string };
  expiresAt: number;
}>();
const routeChecksInFlight = new Map<string, Promise<{ vpn: boolean; dev: string }>>();

// Adjust this if your VPN uses a different interface name. Tailscale is
// included because it commonly installs a tailscale0 route interface.
export const VPN_INTERFACE = /^(tun|tap|wg|ppp|ipsec|tailscale|zt|mullvad|nordlynx)/i;

/** Inspect the route to a public address and report whether it uses a VPN. */
export async function routeUsesVpn(
  destination = "8.8.8.8",
): Promise<{ vpn: boolean; dev: string }> {
  const now = Date.now();
  const cached = routeCache.get(destination);
  if (cached && cached.expiresAt > now) return cached.result;

  const existingCheck = routeChecksInFlight.get(destination);
  if (existingCheck) return existingCheck;

  const check = execFileAsync("ip", ["route", "get", destination], {
    timeout: 2000,
    maxBuffer: 16 * 1024,
  })
    .then(({ stdout }) => {
      const dev = stdout.trim().match(/\bdev\s+(\S+)/i)?.[1] ?? "";
      const result = { vpn: VPN_INTERFACE.test(dev), dev };
      routeCache.set(destination, {
        result,
        expiresAt: Date.now() + VPN_ROUTE_CACHE_TTL_MS,
      });
      return result;
    })
    .finally(() => {
      routeChecksInFlight.delete(destination);
    });

  routeChecksInFlight.set(destination, check);
  return check;
}
