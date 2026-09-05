/**
 * Interactive API-key manager for Pi.
 *
 * Usage:
 *   /manage-key
 *
 * Pi's auth.json stores one active credential per provider. This extension
 * keeps named credentials in key-names.json and copies the selected credential
 * to auth.json when it is activated.
 */
import { chmod, mkdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

type ApiKeyCredential = {
	type: "api_key";
	key?: string;
	env?: Record<string, string>;
};

type AuthData = Record<string, unknown>;
type LegacyKeyNames = Record<string, string>;
type SavedKey = {
	provider: string;
	name: string;
	credential: ApiKeyCredential;
};
type SavedKeysData = SavedKey[] | LegacyKeyNames;

const AUTH_FILE = join(getAgentDir(), "auth.json");
// The file name is retained for compatibility with the first version of this
// extension. It now stores named credentials rather than only provider names.
const KEY_NAMES_FILE = join(getAgentDir(), "key-names.json");
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MS = 50;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isApiKeyCredential(value: unknown): value is ApiKeyCredential {
	return isObject(value) && value.type === "api_key" &&
		(value.key === undefined || typeof value.key === "string") &&
		(value.env === undefined || (
			isObject(value.env) &&
			Object.values(value.env).every((entry) => typeof entry === "string")
		));
}

function isSavedKey(value: unknown): value is SavedKey {
	return isObject(value) && typeof value.provider === "string" && typeof value.name === "string" &&
		isApiKeyCredential(value.credential);
}

function maskKey(key: string | undefined): string {
	if (!key) return "(no literal key)";
	if (key.startsWith("$") || key.startsWith("!")) return "(configured reference)";
	if (key.length <= 4) return "••••";
	return `••••${key.slice(-4)}`;
}

function parseAuthFile(content: string): AuthData {
	if (!content.trim()) return {};
	const parsed: unknown = JSON.parse(content);
	if (!isObject(parsed)) throw new Error("auth.json must contain a JSON object");
	return parsed;
}

function parseSavedKeysFile(content: string): SavedKeysData {
	if (!content.trim()) return [];
	const parsed: unknown = JSON.parse(content);

	// Current format: { "keys": [{ provider, name, credential }] }.
	if (isObject(parsed) && Array.isArray(parsed.keys)) {
		if (!parsed.keys.every(isSavedKey)) {
			throw new Error("key-names.json contains an invalid saved API key");
		}
		return parsed.keys;
	}

	// First-version format: { "provider-id": "display name" }.
	// It is converted to a profile for the currently active credential when
	// loaded. A future write replaces it with the current format.
	if (isObject(parsed) && Object.values(parsed).every((name) => typeof name === "string")) {
		return parsed as LegacyKeyNames;
	}

	throw new Error("key-names.json must contain saved API keys");
}

/**
 * Pi uses a directory lock beside auth.json. Use the same convention here.
 * In particular, do not write non-empty content with the append flag: that
 * would append a second JSON value to auth.json every time the lock is taken.
 */
async function withJsonFileLock<T, TData>(
	filePath: string,
	parse: (content: string) => TData,
	fn: (data: TData) => Promise<T>,
): Promise<T> {
	const lockDir = `${filePath}.lock`;
	await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
	await writeFile(filePath, "", { flag: "a", mode: 0o600 });
	await chmod(filePath, 0o600);

	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	while (true) {
		try {
			await mkdir(lockDir);
			break;
		} catch (error) {
			const code = isObject(error) && "code" in error ? String(error.code) : "";
			if (code !== "EEXIST") throw error;

			try {
				const lockStat = await stat(lockDir);
				if (Date.now() - lockStat.mtimeMs > LOCK_TIMEOUT_MS) {
					await rmdir(lockDir).catch(() => undefined);
					continue;
				}
			} catch {
				// The owner released the lock between mkdir and stat.
				continue;
			}

			if (Date.now() >= deadline) {
				throw new Error(`Timed out waiting for ${filePath} to become available`);
			}
			await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
		}
	}

	try {
		return await fn(parse(await readFile(filePath, "utf8")));
	} finally {
		await rmdir(lockDir).catch(() => undefined);
	}
}

async function saveJsonFile(filePath: string, data: unknown): Promise<void> {
	const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(tempFile, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await chmod(tempFile, 0o600);
		await rename(tempFile, filePath);
	} finally {
		await unlink(tempFile).catch(() => undefined);
	}
}

async function withAuthFileLock<T>(fn: (auth: AuthData) => Promise<T>): Promise<T> {
	return withJsonFileLock(AUTH_FILE, parseAuthFile, fn);
}

async function withSavedKeysFileLock<T>(fn: (keys: SavedKey[]) => Promise<T>): Promise<T> {
	return withJsonFileLock(KEY_NAMES_FILE, parseSavedKeysFile, async (data) => {
		// Legacy names cannot contain a key. They are migrated by loadSavedKeys
		// before this function is used for a write.
		return fn(Array.isArray(data) ? data : []);
	});
}

function legacyKeysToProfiles(data: LegacyKeyNames, auth: AuthData): SavedKey[] {
	return Object.entries(data).flatMap(([provider, name]) => {
		const credential = auth[provider];
		return isApiKeyCredential(credential) ? [{ provider, name, credential }] : [];
	});
}

async function readAuthFile(): Promise<AuthData> {
	try {
		return parseAuthFile(await readFile(AUTH_FILE, "utf8"));
	} catch (error) {
		const code = isObject(error) && "code" in error ? String(error.code) : "";
		if (code === "ENOENT") return {};
		throw error;
	}
}

async function loadSavedKeys(auth: AuthData): Promise<SavedKey[]> {
	try {
		return await withJsonFileLock(KEY_NAMES_FILE, parseSavedKeysFile, async (data) => {
			if (Array.isArray(data)) return data;
			const keys = legacyKeysToProfiles(data, auth);
			await saveJsonFile(KEY_NAMES_FILE, { keys });
			return keys;
		});
	} catch (error) {
		const code = isObject(error) && "code" in error ? String(error.code) : "";
		if (code === "ENOENT") return [];
		throw error;
	}
}

async function saveSavedKey(key: SavedKey): Promise<void> {
	await withSavedKeysFileLock(async (keys) => {
		const index = keys.findIndex((entry) => entry.provider === key.provider && entry.name === key.name);
		if (index >= 0) keys[index] = key;
		else keys.push(key);
		await saveJsonFile(KEY_NAMES_FILE, { keys });
	});
}

async function refreshCredentialState(ctx: ExtensionCommandContext): Promise<void> {
	try {
		await ctx.modelRegistry.refresh();
	} catch {
		// The file is saved; a later model request/reload can still pick it up.
	}
}

async function askForName(ctx: ExtensionCommandContext): Promise<string | undefined> {
	const name = await ctx.ui.input("Name for this API key", "e.g. personal, work, or staging");
	if (name === undefined) return undefined;
	return name.trim();
}

async function askForKey(ctx: ExtensionCommandContext): Promise<string | undefined> {
	const key = await ctx.ui.input("Paste the API key", "Paste the API key here");
	const trimmed = key?.trim();
	return trimmed || undefined;
}

function getProviderIds(ctx: ExtensionCommandContext, auth: AuthData): string[] {
	const ids = new Set<string>([
		...ctx.modelRegistry.getAll().map((model) => model.provider),
		...ctx.modelRegistry.getRegisteredProviderIds(),
		...Object.keys(auth),
	]);
	return [...ids].sort((a, b) => {
		const nameCompare = ctx.modelRegistry
			.getProviderDisplayName(a)
			.localeCompare(ctx.modelRegistry.getProviderDisplayName(b));
		return nameCompare || a.localeCompare(b);
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("manage-key", {
		description: "Save and switch between API keys",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/manage-key requires interactive mode", "error");
				return;
			}

			const action = await ctx.ui.select("Manage API keys", [
				"Add and use a new API key",
				"Use a saved API key",
			]);
			if (!action) return;

			let auth: AuthData;
		try {
			auth = await readAuthFile();
		} catch (error) {
			ctx.ui.notify(`Could not read auth.json: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}

			let savedKeys: SavedKey[];
		try {
			savedKeys = await loadSavedKeys(auth);
		} catch (error) {
			ctx.ui.notify(`Could not read saved API keys: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}

			let selectedProvider: string | undefined;
			let selectedCredential: ApiKeyCredential | undefined;
			let selectedName: string | undefined;

			if (action === "Use a saved API key") {
				if (savedKeys.length === 0) {
					ctx.ui.notify("No saved API keys found. Add a new API key first.", "info");
					return;
				}

				const sortedKeys = [...savedKeys].sort((a, b) =>
					a.name.localeCompare(b.name) || a.provider.localeCompare(b.provider),
				);
				const choices = sortedKeys.map((entry) =>
					`${entry.name} — ${ctx.modelRegistry.getProviderDisplayName(entry.provider)} (${entry.provider}) — ${maskKey(entry.credential.key)}`,
				);
				const choice = await ctx.ui.select("Select the API key to use from now on", choices);
				if (!choice) return;
				const index = choices.indexOf(choice);
				if (index < 0) return;

				const selected = sortedKeys[index];
				selectedProvider = selected.provider;
				selectedCredential = selected.credential;
				selectedName = selected.name;
			} else {
				const providerIds = getProviderIds(ctx, auth);
				if (providerIds.length === 0) {
					ctx.ui.notify("No providers are available", "error");
					return;
				}
				const providerChoices = providerIds.map(
					(id) => `${ctx.modelRegistry.getProviderDisplayName(id)} — ${id}`,
				);
				const providerChoice = await ctx.ui.select("Select provider", providerChoices);
				if (!providerChoice) return;
				const providerIndex = providerChoices.indexOf(providerChoice);
				if (providerIndex < 0) return;
				selectedProvider = providerIds[providerIndex];
				if (!selectedProvider) return;

				const current = auth[selectedProvider];
				if (current !== undefined && !isApiKeyCredential(current)) {
					const confirmed = await ctx.ui.confirm(
						"Credential already exists",
						`${selectedProvider} already has a non-API-key credential. Replace it?`,
					);
					if (!confirmed) return;
				}

				selectedName = await askForName(ctx);
				if (selectedName === undefined) return;
				if (!selectedName) {
					ctx.ui.notify("A name is required for each API key", "error");
					return;
				}

				selectedCredential = {
					type: "api_key",
					key: await askForKey(ctx),
					...(isApiKeyCredential(current) && current.env ? { env: current.env } : {}),
				};
				if (!selectedCredential.key) {
					ctx.ui.notify("No API key entered; nothing was changed", "info");
					return;
				}

				const duplicate = savedKeys.find(
					(entry) => entry.provider === selectedProvider && entry.name === selectedName,
				);
				if (duplicate) {
					const confirmed = await ctx.ui.confirm(
						"Saved API key already exists",
						`Replace the saved key named “${selectedName}” for ${selectedProvider}?`,
					);
					if (!confirmed) return;
				}
			}

			try {
				if (!selectedProvider || !selectedCredential || !selectedName) return;
				await withAuthFileLock(async (currentAuth) => {
					currentAuth[selectedProvider!] = selectedCredential;
					await saveJsonFile(AUTH_FILE, currentAuth);
				});
				if (action === "Add and use a new API key") {
					await saveSavedKey({ provider: selectedProvider, name: selectedName, credential: selectedCredential });
				}
			} catch (error) {
				ctx.ui.notify(`Could not save API key: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			await refreshCredentialState(ctx);
			ctx.ui.notify(`Now using saved API key “${selectedName}” for ${selectedProvider}`, "info");
		},
	});
}
