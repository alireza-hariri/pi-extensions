import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import { Key, SelectList, Container, Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { LLMCall } from "./shared/lib.ts";

/**
 * Jira integration for pi.
 *
 * Configuration is stored in ~/.pi/agent/jira.json and can be created with
 * /config-jira. Profiles may use username/password authentication or a
 * standalone API key sent as a Bearer token.
 */
const configPath = join(homedir(), ".pi", "agent", "jira.json");

type JiraAuth = "basic" | "bearer";
type JiraProfile = {
  name: string;
  auth: JiraAuth;
  username?: string;
  pass?: string;
  token?: string;
};
type JiraConfig = {
  url: string;
  auth: JiraAuth;
  username?: string;
  pass?: string;
  token?: string;
  users?: JiraProfile[];
  defaultUser?: string;
  /** The selected profile for this Pi process; it is intentionally not persisted. */
  profileName?: string;
  jiraAddProjectKey?: string;
  jiraAddIssueType?: string;
  jiraAddAssignees?: string[];
};

// The active profile is process-local. A new Pi session starts with the persisted default.
let activeJiraProfileName: string | undefined;
type JiraIssue = {
  key: string;
  fields: {
    summary?: string;
    description?: unknown;
    status?: { name?: string };
    priority?: { name?: string };
    issuetype?: { name?: string };
    assignee?: { displayName?: string };
    parent?: { key?: string };
  };
};

function normalizeProfile(value: any, fallbackName = "default"): JiraProfile | undefined {
  const name = typeof value?.name === "string" && value.name.trim() ? value.name.trim() : fallbackName;
  const auth: JiraAuth = value?.auth === "bearer" || typeof value?.token === "string" ? "bearer" : "basic";
  if (auth === "bearer") {
    if (typeof value?.token !== "string" || !value.token) return undefined;
    return { name, auth, token: value.token };
  }
  if (typeof value?.username !== "string" || typeof value?.pass !== "string") return undefined;
  return { name, auth, username: value.username, pass: value.pass };
}

async function loadConfig(): Promise<JiraConfig | undefined> {
  try {
    const value = JSON.parse(await readFile(configPath, "utf8")) as any;
    if (typeof value.url !== "string" || !value.url.trim()) return undefined;
    // Files without a users array are the original single-user format.
    // Once profiles exist, the top-level credentials are only a compatibility
    // mirror of the default/selected profile and must not become another user.
    const hasProfiles = Array.isArray(value.users);
    const legacy = hasProfiles ? undefined : normalizeProfile(value, "default");
    const profiles = (hasProfiles ? value.users : [])
      .map((item: any) => normalizeProfile(item))
      .filter((item: JiraProfile | undefined): item is JiraProfile => Boolean(item));
    if (legacy) profiles.unshift(legacy);
    if (profiles.length === 0) return undefined;
    const defaultName = typeof value.defaultUser === "string" ? value.defaultUser : profiles[0].name;
    const selectedName = activeJiraProfileName ?? defaultName;
    const profile = profiles.find((item) => item.name.toLowerCase() === selectedName.toLowerCase())
      ?? profiles.find((item) => item.name.toLowerCase() === defaultName.toLowerCase())
      ?? profiles[0];
    activeJiraProfileName = activeJiraProfileName ? profile.name : undefined;
    return {
      ...profile,
      url: value.url.replace(/\/+$/, ""),
      users: profiles,
      defaultUser: defaultName,
      profileName: profile.name,
      jiraAddProjectKey: typeof value.jiraAddProjectKey === "string" ? value.jiraAddProjectKey.trim() : undefined,
      jiraAddIssueType: typeof value.jiraAddIssueType === "string" ? value.jiraAddIssueType.trim() : undefined,
      jiraAddAssignees: Array.isArray(value.jiraAddAssignees)
        ? value.jiraAddAssignees.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
        : undefined,
    };
  } catch {
    // Not configured yet, or malformed configuration.
  }
  return undefined;
}

async function saveConfig(config: JiraConfig): Promise<void> {
  const profiles = config.users?.length
    ? config.users
    : [{ name: "default", auth: config.auth, username: config.username, pass: config.pass, token: config.token }];
  const selected = profiles.find((item) => item.name === config.profileName) ?? profiles[0];
  const persisted = {
    url: config.url,
    auth: selected.auth ?? "basic",
    username: selected.username,
    pass: selected.pass,
    token: selected.token,
    users: profiles,
    defaultUser: config.defaultUser ?? profiles[0].name,
    jiraAddProjectKey: config.jiraAddProjectKey,
    jiraAddIssueType: config.jiraAddIssueType,
    jiraAddAssignees: config.jiraAddAssignees,
  };
  await writeFile(configPath, JSON.stringify({ ...persisted, url: persisted.url.replace(/\/+$/, "") }, null, 2) + "\n", { mode: 0o600 });
  await chmod(configPath, 0o600);
}

async function jiraRequest(config: JiraConfig, path: string, init: RequestInit = {}): Promise<any> {
  const headers = new Headers(init.headers);
  if (config.auth === "bearer") {
    if (!config.token) throw new Error("The active Jira profile has no API key/token");
    headers.set("Authorization", `Bearer ${config.token}`);
  } else {
    if (!config.username || !config.pass) throw new Error("The active Jira profile has incomplete username/password credentials");
    headers.set("Authorization", `Basic ${Buffer.from(`${config.username}:${config.pass}`).toString("base64")}`);
  }
  headers.set("Accept", "application/json");
  const response = await fetch(`${config.url}${path}`, { ...init, headers });
  const text = await response.text();
  let body: any;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  if (!response.ok) {
    const detail = typeof body === "object" ? body?.errorMessages?.join(", ") || body?.message : body;
    throw new Error(`Jira ${response.status}: ${detail || response.statusText}`);
  }
  return body;
}

async function searchIssues(config: JiraConfig): Promise<JiraIssue[]> {
  const fields = "summary,description,status,priority,issuetype,assignee,parent";
  const search = async (jql: string): Promise<JiraIssue[]> => {
    // Jira Server/DC and older Jira Cloud installations expose this endpoint.
    try {
      const result = await jiraRequest(config, `/rest/api/2/search?jql=${encodeURIComponent(jql)}&fields=${fields}&maxResults=100`);
      return (result.issues ?? []) as JiraIssue[];
    } catch (firstError) {
      // Newer Jira Cloud uses the /search/jql resource.
      try {
        const result = await jiraRequest(config, "/rest/api/3/search/jql", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jql, fields: fields.split(","), maxResults: 100 }),
        });
        return (result.issues ?? []) as JiraIssue[];
      } catch {
        throw firstError;
      }
    }
  };

  const openSprintIssues = await search(
    "assignee = currentUser() AND sprint in openSprints() ORDER BY Rank ASC, status  DESC",
  );
  if (openSprintIssues.length > 0) return openSprintIssues;

  // Some Jira installations do not report the active sprint through openSprints().
  // In that case, include issues from sprints that have not been closed yet.
  return search(
    "assignee = currentUser() AND sprint not in closedSprints() ORDER BY Rank ASC, status  DESC",
  );
}

function formatIssues(config: JiraConfig, issues: JiraIssue[]): string {
  if (issues.length === 0) return "No tasks assigned to you in the current sprint.";
  const lines = [`Current sprint — ${issues.length} task${issues.length === 1 ? "" : "s"}`];
  for (const issue of issues.slice(0,4)) {
    const f = issue.fields ?? {};
    const status = f.status?.name ?? "Unknown status";
    const priority = f.priority?.name ? ` | ${f.priority.name}` : "";
    lines.push(`- ${issue.key} [${status}${priority}] ${f.summary ?? "(no summary)"}`);
    lines.push(`  ${config.url}/browse/${issue.key}`);
  }
  return lines.join("\n");
}

async function getTasks(): Promise<{ text: string; issues?: JiraIssue[]; config?: JiraConfig }> {
  const config = await loadConfig();
  if (!config) throw new Error(`Jira is not configured. Run /config-jira (config: ${configPath})`);
  const issues = await searchIssues(config);
  return { text: formatIssues(config, issues), issues, config };
}

type JiraProject = { key: string; name: string };
type JiraUser = {
  displayName?: string;
  name?: string;
  key?: string;
  accountId?: string;
  emailAddress?: string;
  active?: boolean;
};
type JiraIssueType = { id: string; name: string; subtask?: boolean };

async function listProjects(config: JiraConfig): Promise<JiraProject[]> {
  const result = await jiraRequest(config, "/rest/api/2/project");
  const projects = Array.isArray(result) ? result : result?.values;
  return (Array.isArray(projects) ? projects : [])
    .filter((project: any) => typeof project?.key === "string" && typeof project?.name === "string")
    .map((project: any) => ({ key: project.key, name: project.name }));
}

async function rankJiraIssueAtPosition(
  config: JiraConfig,
  projectKey: string,
  issueKey: string,
  requestedPosition: number,
): Promise<void> {
  const boardsResult = await jiraRequest(
    config,
    `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}&maxResults=50`,
  );
  const boards = Array.isArray(boardsResult) ? boardsResult : boardsResult?.values;
  const board = Array.isArray(boards) ? boards.find((item: any) => typeof item?.id === "number") : undefined;
  if (!board) throw new Error(`No Jira board was found for project ${projectKey}`);

  const backlogResult = await jiraRequest(
    config,
    `/rest/agile/1.0/board/${board.id}/backlog?startAt=0&maxResults=1000`,
  );
  const issues = (Array.isArray(backlogResult) ? backlogResult : backlogResult?.issues ?? [])
    .filter((issue: any) => typeof issue?.key === "string" && issue.key !== issueKey);
  if (issues.length === 0) return;

  const position = Math.max(1, Math.min(requestedPosition, issues.length + 1));
  const body = position === 1
    ? { issues: [issueKey], rankBeforeIssue: issues[0].key }
    : { issues: [issueKey], rankAfterIssue: issues[position - 2].key };
  await jiraRequest(config, "/rest/agile/1.0/issue/rank", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function listAssignableUsers(config: JiraConfig, projectKey: string): Promise<JiraUser[]> {
  const query = `project=${encodeURIComponent(projectKey)}&maxResults=1000`;
  try {
    const result = await jiraRequest(config, `/rest/api/2/user/assignable/search?${query}`);
    return Array.isArray(result) ? result : result?.values ?? [];
  } catch (firstError) {
    try {
      // Some Jira Server versions expose the pluralized variant.
      const result = await jiraRequest(config, `/rest/api/2/users/assignable/search?${query}`);
      return Array.isArray(result) ? result : result?.values ?? [];
    } catch {
      throw firstError;
    }
  }
}

async function listIssueTypes(config: JiraConfig, projectKey: string): Promise<JiraIssueType[]> {
  try {
    const result = await jiraRequest(
      config,
      `/rest/api/2/issue/createmeta?projectKeys=${encodeURIComponent(projectKey)}&expand=projects.issuetypes`,
    );
    const issueTypes = result?.projects?.[0]?.issuetypes;
    if (Array.isArray(issueTypes) && issueTypes.length > 0) {
      return issueTypes
        .filter((issueType: any) => typeof issueType?.id === "string" && typeof issueType?.name === "string")
        .map((issueType: any) => ({ id: issueType.id, name: issueType.name, subtask: issueType.subtask }));
    }
  } catch {
    // Fall back to the global issue-type endpoint below.
  }

  const result = await jiraRequest(config, "/rest/api/2/issuetype");
  return (Array.isArray(result) ? result : [])
    .filter((issueType: any) => typeof issueType?.id === "string" && typeof issueType?.name === "string" && !issueType.subtask)
    .map((issueType: any) => ({ id: issueType.id, name: issueType.name }));
}

function userIdentifier(user: JiraUser): string | undefined {
  // Jira Server/Data Center uses `name`; Jira Cloud uses `accountId`.
  return user.name ?? user.key ?? user.accountId;
}

async function createJiraTask(
  config: JiraConfig,
  project: JiraProject,
  issueType: JiraIssueType,
  user: JiraUser,
  description: string,
): Promise<{ key: string; self?: string }> {
  const summary = description.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 255);
  if (!summary) throw new Error("The task description cannot be empty");

  const identifier = userIdentifier(user);
  if (!identifier) throw new Error("The selected Jira user has no usable identifier");

  const body = {
    fields: {
      project: { key: project.key },
      summary,
      description,
      issuetype: { id: issueType.id },
      assignee: user.name || user.key ? { name: identifier } : { accountId: identifier },
    },
  };
  return jiraRequest(config, "/rest/api/2/issue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function chooseJiraItem<T>(
  ctx: ExtensionContext,
  title: string,
  items: T[],
  label: (item: T) => string,
): Promise<T | undefined> {
  if (!ctx.hasUI || items.length === 0) return undefined;
  const labels = items.map(label);
  const selected = await ctx.ui.select(title, labels);
  if (selected === undefined) return undefined;
  const index = labels.indexOf(selected);
  return index >= 0 ? items[index] : undefined;
}

function jiraUserLabel(user: JiraUser): string {
  const id = userIdentifier(user);
  return `${user.displayName ?? id}${id && user.displayName ? ` (${id})` : ""}`;
}

function configuredUserMatches(user: JiraUser, configured: Set<string>): boolean {
  const identifiers = [user.displayName, user.name, user.key, user.accountId, user.emailAddress]
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.toLowerCase());
  return identifiers.some((item) => configured.has(item));
}

async function chooseJiraUsers(
  ctx: ExtensionContext,
  users: JiraUser[],
  initiallySelected: Set<string>,
): Promise<JiraUser[] | undefined> {
  if (!ctx.hasUI || users.length === 0) return undefined;
  const result = await ctx.ui.custom<JiraUser[] | null>((tui, theme, _keybindings, done) => {
    let cursor = 0;
    const selected = new Set(initiallySelected);
    let cachedLines: string[] | undefined;

    const refresh = () => {
      cachedLines = undefined;
      tui.requestRender();
    };

    const finish = () => done(users.filter((user) => {
      const identifiers = [user.displayName, user.name, user.key, user.accountId, user.emailAddress]
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.toLowerCase());
      return identifiers.some((item) => selected.has(item));
    }));

    return {
      render: (width: number) => {
        if (cachedLines) return cachedLines;
        const visibleRows = Math.min(users.length, 12);
        const start = Math.min(Math.max(0, cursor - visibleRows + 1), Math.max(0, users.length - visibleRows));
        const end = Math.min(users.length, start + visibleRows);
        const lines = [
          theme.fg("accent", "Select allowed Jira assignees"),
          theme.fg("dim", "↑↓ move • space toggle • enter save • esc cancel"),
          "",
        ];
        for (let index = start; index < end; index++) {
          const user = users[index];
          const identifiers = [user.displayName, user.name, user.key, user.accountId, user.emailAddress]
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.toLowerCase());
          const isSelected = identifiers.some((item) => selected.has(item));
          const prefix = index === cursor ? theme.fg("accent", "> ") : "  ";
          const checkbox = isSelected ? theme.fg("success", "[x] ") : theme.fg("muted", "[ ] ");
          lines.push(truncateToWidth(`${prefix}${checkbox}${jiraUserLabel(user)}`, width));
        }
        if (start > 0 || end < users.length) {
          lines.push(theme.fg("dim", `Showing ${start + 1}-${end} of ${users.length}`));
        }
        cachedLines = lines;
        return lines;
      },
      invalidate: () => { cachedLines = undefined; },
      handleInput: (data: string) => {
        if (matchesKey(data, Key.up)) {
          cursor = Math.max(0, cursor - 1);
          refresh();
        } else if (matchesKey(data, Key.down)) {
          cursor = Math.min(users.length - 1, cursor + 1);
          refresh();
        } else if (matchesKey(data, Key.space)) {
          const user = users[cursor];
          const identifiers = [user.displayName, user.name, user.key, user.accountId, user.emailAddress]
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.toLowerCase());
          const isSelected = identifiers.some((item) => selected.has(item));
          if (isSelected) identifiers.forEach((item) => selected.delete(item));
          else identifiers.forEach((item) => selected.add(item));
          refresh();
        } else if (matchesKey(data, Key.enter)) {
          finish();
        } else if (matchesKey(data, Key.escape)) {
          done(null);
        }
      },
    };
  });
  return result ?? undefined;
}

async function addJiraTask(description: string, ctx: ExtensionContext): Promise<{ key: string; url: string } | undefined> {
  if (!ctx.hasUI) throw new Error("Adding a Jira task requires interactive mode");
  const config = await loadConfig();
  if (!config) throw new Error(`Jira is not configured. Run /config-jira (config: ${configPath})`);

  const projectKey = config.jiraAddProjectKey;
  if (!projectKey) throw new Error(`Jira add is not configured. Run /jira-add-config (config: ${configPath})`);
  const project: JiraProject = { key: projectKey, name: projectKey };

  const issueTypeName = config.jiraAddIssueType ?? "Story";
  const issueTypes = await listIssueTypes(config, project.key);
  const issueType = issueTypes.find((item) => item.name.toLowerCase() === issueTypeName.toLowerCase());
  if (!issueType) throw new Error(`Issue type ${issueTypeName} is not available in Jira project ${project.key}`);

  const allowedAssignees = new Set((config.jiraAddAssignees ?? []).map((item) => item.toLowerCase()));
  let users = (await listAssignableUsers(config, project.key))
    .filter((user) => user.active !== false && userIdentifier(user));
  if (allowedAssignees.size > 0) users = users.filter((user) => configuredUserMatches(user, allowedAssignees));
  if (users.length === 0) throw new Error(`No configured assignable Jira users were found for project ${project.key}`);
  const user = await chooseJiraItem(ctx, "Select the assignee", users, jiraUserLabel);
  if (!user) return undefined;

  const summary = description.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "(no summary)";
  const assignee = user.displayName ?? userIdentifier(user) ?? "selected user";
  const backlogPositionText = await ctx.ui.input(
    "Backlog position (1 = first; leave blank to keep Jira's default position):",
    "",
  );
  if (backlogPositionText === undefined) return undefined;
  const trimmedPosition = backlogPositionText.trim();
  let backlogPosition: number | undefined;
  if (trimmedPosition) {
    backlogPosition = Number(trimmedPosition);
    if (!Number.isInteger(backlogPosition) || backlogPosition < 1) {
      throw new Error("Backlog position must be a positive whole number");
    }
  }

  const positionSummary = backlogPosition ? `\nBacklog position: ${backlogPosition}` : "\nBacklog position: Jira default";
  const confirmed = await ctx.ui.confirm(
    "Create Jira task?",
    `${project.key} / ${issueType.name}\n${summary}\nAssignee: ${assignee}${positionSummary}`,
  );
  if (!confirmed) return undefined;

  const issue = await createJiraTask(config, project, issueType, user, description);
  if (!issue?.key) throw new Error("Jira created the task but did not return its issue key");

  if (backlogPosition !== undefined) {
    try {
      await rankJiraIssueAtPosition(config, project.key, issue.key, backlogPosition);
    } catch (error) {
      throw new Error(`Task ${issue.key} was created, but it could not be moved to backlog position ${backlogPosition}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { key: issue.key, url: `${config.url}/browse/${issue.key}` };
}

function orcaErrorMessage(args: string[], result: { code: number; stdout: string; stderr: string }, body: any): string {
  const message = body?.error?.message || body?.error || result.stderr.trim() || result.stdout.trim();
  return `Orca ${args.join(" ")}: ${message || `exited with code ${result.code}`}`;
}

function isOrcaNotRunningError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("could not connect to the running orca app")
    || normalized.includes("orca is not running")
    || normalized.includes("run 'orca open' first")
    // The CLI may report a missing runtime metadata file instead of saying
    // directly that the app is not running.
    || normalized.includes("orca runtime metadata")
    || normalized.includes("start the orca app");
}

async function currentDesktop(): Promise<number | undefined> {
  try {
    const result = await runProcess("qdbus6", ["org.kde.KWin", "/KWin", "currentDesktop"]);
    if (result.code === 0) {
      const desktop = Number.parseInt(result.stdout.trim(), 10);
      if (Number.isInteger(desktop)) return desktop;
    }
  } catch {
    // Try dbus-send below.
  }

  try {
    const result = await runProcess("dbus-send", [
      "--session",
      "--print-reply",
      "--dest=org.kde.KWin",
      "/KWin",
      "org.kde.KWin.currentDesktop",
    ]);
    const match = result.stdout.match(/int32\s+(\d+)/);
    return match ? Number.parseInt(match[1], 10) : undefined;
  } catch {
    return undefined;
  }
}

async function switchToDesktop(desktop: number): Promise<void> {
  // KDE's desktop numbering is one-based. The DBus call only requests the
  // change; KWin may apply it just after the call returns, so verify the
  // resulting desktop before continuing.
  if (await currentDesktop() === desktop) return;

  let requestSucceeded = false;
  try {
    const result = await runProcess("qdbus6", ["org.kde.KWin", "/KWin", "setCurrentDesktop", String(desktop)]);
    requestSucceeded = result.code === 0;
  } catch {
    // Try dbus-send below.
  }

  if (!requestSucceeded) {
    try {
      const result = await runProcess("dbus-send", [
        "--session",
        "--type=method_call",
        "--dest=org.kde.KWin",
        "/KWin",
        "org.kde.KWin.setCurrentDesktop",
        `int32:${desktop}`,
      ]);
      requestSucceeded = result.code === 0;
    } catch {
      // Report the failure after the verification loop below.
    }
  }

  if (!requestSucceeded) throw new Error(`Could not request KDE desktop ${desktop}`);

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await currentDesktop() === desktop) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`KDE did not switch to desktop ${desktop}`);
}

async function switchToDesktopTwo(): Promise<void> {
  await switchToDesktop(2);
}

async function startOrcaServerInTmux(): Promise<void> {
  const session = `pi-orca-serve-${process.pid}`;
  const started = await runProcess("tmux", ["new-session", "-d", "-s", session, "orca", "serve"]);
  if (started.code !== 0) {
    const detail = started.stderr.trim() || started.stdout.trim() || `exited with code ${started.code}`;
    throw new Error(`Could not start Orca server in tmux: ${detail}`);
  }
  // Give the server a moment to write its runtime metadata and register its
  // IPC endpoint before retrying.
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function orcaJson(args: string[], recover = true): Promise<any> {
  const result = await runProcess("orca", [...args, "--json"]);
  let body: any;
  try {
    body = result.stdout ? JSON.parse(result.stdout) : undefined;
  } catch {
    body = undefined;
  }
  if (result.code !== 0 || body?.ok === false) {
    const message = orcaErrorMessage(args, result, body);
    if (recover && isOrcaNotRunningError(message)) {
      await startOrcaServerInTmux();
      return orcaJson(args, false);
    }
    throw new Error(message);
  }
  return body?.result ?? body;
}

async function loadRepositories(): Promise<{ name: string; path: string }[]> {
  const result = await orcaJson(["repo", "list"]);
  const repositories = Array.isArray(result?.repos) ? result.repos : [];
  return repositories
    .filter((repo: any) => typeof repo?.path === "string")
    .map((repo: any) => ({
      name: typeof repo.displayName === "string" && repo.displayName ? repo.displayName : basename(repo.path),
      path: repo.path,
    }));
}

async function choose<T extends { name: string }>(ctx: ExtensionContext, title: string, items: T[]): Promise<T | undefined> {
  if (!ctx.hasUI || items.length === 0) return undefined;
  const selected = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", title), 1, 0));
    const list = new SelectList(
      items.map((item) => ({ value: item.name, label: item.name, description: "description" in item ? String(item.description) : "path" in item ? String(item.path) : undefined })),
      Math.min(items.length, 12),
      {
        selectedPrefix: (s) => theme.fg("accent", s),
        selectedText: (s) => theme.fg("accent", s),
        description: (s) => theme.fg("muted", s),
        scrollInfo: (s) => theme.fg("dim", s),
        noMatch: (s) => theme.fg("warning", s),
      },
    );
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(null);
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => { list.handleInput(data); tui.requestRender(); },
    };
  });
  return items.find((item) => item.name === selected);
}

function runProcess(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data) => { stdout += data; });
    child.stderr?.on("data", (data) => { stderr += data; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function launchDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

type PreparedRepository = {
  mainPath: string;
  worktreePath: string;
  branch: string;
};

const WORKTREE_NAME_MODEL = { provider: "openrouter", id: "google/gemma-3-12b-it" };

async function nameWorktreeBranch(ctx: ExtensionContext, taskSummary: string): Promise<string> {
  let response: string;
  try {
    response = await LLMCall(
      ctx,
      WORKTREE_NAME_MODEL,
      `Create a short git branch name for this task. Return only the branch name, using lowercase kebab-case and no explanation.\n\nTask summary: ${taskSummary}`,
      "You name git branches. Keep names concise, descriptive, and safe to use as a git branch name. Do not include ticket IDs.",
      { maxTokens: 24, temperature: 0.2 },
    );
  } catch (error) {
    throw new Error(`Could not generate worktree branch name: ${error instanceof Error ? error.message : String(error)}`);
  }
  const branch = response
    .replace(/[\r\n]+/g, " ")
    .replace(/^['\"`]+|['\"`]+$/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");

  if (!branch) throw new Error("The naming model returned an empty worktree branch name");
  return branch;
}

async function prepareRepository(
  ctx: ExtensionContext,
  repositoryPath: string,
  taskSummary: string,
): Promise<PreparedRepository> {
  const status = await runProcess("git", ["-C", repositoryPath, "status", "--porcelain"]);
  if (status.code !== 0) {
    throw new Error(`Could not read git status for ${repositoryPath}: ${status.stderr.trim() || status.stdout.trim()}`);
  }

  // Keep the main checkout for VS Code, and always give the Orca terminal its
  // own clean worktree.
  const branch = await nameWorktreeBranch(ctx, taskSummary);
  const created = await orcaJson([
    "worktree",
    "create",
    "--repo",
    `path:${repositoryPath}`,
    "--name",
    branch,
    "--activate",
  ]);
  const worktreePath = created?.worktree?.path ?? created?.path;
  if (typeof worktreePath !== "string" || !worktreePath) {
    throw new Error("Orca created the worktree but did not return its path");
  }
  return { mainPath: repositoryPath, worktreePath, branch };
}

type DevelopmentAgent = {
  name: string;
  command: string;
};

const DEVELOPMENT_AGENTS: DevelopmentAgent[] = [
  { name: "pi", command: "pi" },
  { name: "opencode", command: "opencode" },
  // The Claude Code executable is named `claude`.
  { name: "claudecode", command: "claude" },
];

function extractDescription(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(extractDescription).filter(Boolean).join("\n");

  const node = value as { type?: unknown; text?: unknown; content?: unknown };
  if (typeof node.text === "string") return node.text;
  if (!Array.isArray(node.content)) return "";

  const block = ["doc", "paragraph", "heading", "listItem", "codeBlock", "blockquote"].includes(String(node.type));
  return node.content
    .map(extractDescription)
    .filter(Boolean)
    .join(block ? "\n" : "");
}

function taskPrompt(config: JiraConfig, issue: JiraIssue): string {
  const summary = issue.fields?.summary ?? "(no task summary provided)";
  const lines = [
    `Going to work on this Jira task.`,
    `Title: ${summary}`,
    `URL: ${config.url}/browse/${issue.key}`,
  ];
  const description = extractDescription(issue.fields?.description);
  if (description) lines.push("", "Description:", description);
  return lines.join("\n");
}

async function openInTools(worktreePath: string, agent: DevelopmentAgent, prompt: string): Promise<void> {
  // Switch before creating/focusing Orca's terminal. --focus changes Orca's
  // active view, but does not reliably change KDE's virtual desktop.
  await switchToDesktopTwo();

  // Orca owns the terminal session and active-checkout view. --focus makes
  // sure the newly created terminal is activated for the user.
  const created = await orcaJson([
    "terminal",
    "create",
    "--worktree",
    `path:${worktreePath}`,
    "--command",
    agent.command,
    "--focus",
  ]);
  const handle = created?.handle ?? created?.terminal?.handle ?? created?.terminalHandle;
  if (typeof handle !== "string" || !handle) {
    throw new Error("Orca created the agent terminal but did not return its handle");
  }

  // Do not send while the agent is still starting. tui-idle means the
  // interactive UI has finished rendering and is accepting input; unlike a
  // fixed sleep, it also handles agents with slower startup times.
  await orcaJson(["terminal", "wait", "--terminal", handle, "--for", "tui-idle", "--timeout-ms", "15000"]);
  const terminalResult = await orcaJson(["terminal", "show", "--terminal", handle]);
  const terminal = terminalResult?.terminal ?? terminalResult;
  if (terminal?.connected !== true || terminal?.writable !== true) {
    throw new Error("The agent terminal is not connected and writable yet");
  }

  // Send literal text without --enter. Orca pastes it into the agent's input
  // editor so the user can review or edit the prompt before submitting it.
  await orcaJson(["terminal", "send", "--terminal", handle, "--text", prompt]);
}

export default function developmentWorkflowExtension(pi: ExtensionAPI) {
  pi.registerCommand("config-jira", {
    description: "Configure Jira URL and the default profile credentials",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(`Run /config-jira in interactive mode (config: ${configPath})`, "error");
        return;
      }
      const existing = await loadConfig();
      const url = await ctx.ui.input("Jira URL (for example https://jira.example.com):", existing?.url ?? "");
      if (!url) return;
      const authChoice = await ctx.ui.select("Jira authentication", ["username + password/API token", "standalone API key"]);
      if (!authChoice) return;
      const profileName = existing?.profileName ?? "default";
      let profile: JiraProfile;
      if (authChoice === "standalone API key") {
        const token = await ctx.ui.input("Jira API key:", "");
        if (!token) return;
        profile = { name: profileName, auth: "bearer", token };
      } else {
        const username = await ctx.ui.input("Jira username/email:", existing?.username ?? "");
        if (!username) return;
        const pass = await ctx.ui.input("Jira password or API token:", "");
        if (!pass) return;
        profile = { name: profileName, auth: "basic", username, pass };
      }
      const users = (existing?.users ?? []).filter((item) => item.name.toLowerCase() !== profileName.toLowerCase());
      users.push(profile);
      await saveConfig({
        ...(existing ?? { url, ...profile }),
        ...profile,
        url,
        users,
        profileName,
        defaultUser: existing?.defaultUser ?? profileName,
      });
      ctx.ui.notify(`Jira configuration saved to ${configPath} for user ${profileName}`, "info");
    },
  });

  pi.registerCommand("jira-user", {
    description: "Add, change, or set the default Jira API user",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Run /jira-user in interactive mode", "error");
        return;
      }
      try {
        const config = await loadConfig();
        const action = args.trim().toLowerCase() || await ctx.ui.select("Jira user action", ["add user", "change user", "set default user"]);
        if (!action) return;
        if (!config && !action.includes("add")) throw new Error(`Jira is not configured. Use /jira-user add user first`);

        if (action === "add" || action === "add user") {
          const currentUser = config?.profileName ?? "none configured";
          const name = await ctx.ui.input(`New profile name (current user: ${currentUser}):`, "");
          if (!name?.trim()) return;
          if (config?.users?.some((item) => item.name.toLowerCase() === name.trim().toLowerCase())) {
            throw new Error(`Jira user profile ${name.trim()} already exists`);
          }
          const url = config?.url;
          if (!url) throw new Error("Jira URL is not configured. Run /config-jira first.");
          const authChoice = await ctx.ui.select("Jira authentication", ["username + password/API token", "standalone API key"]);
          if (!authChoice) return;
          let profile: JiraProfile;
          if (authChoice === "standalone API key") {
            const token = await ctx.ui.input("Jira API key:", "");
            if (!token) return;
            profile = { name: name.trim(), auth: "bearer", token };
          } else {
            const username = await ctx.ui.input("Jira username/email:", "");
            if (!username) return;
            const pass = await ctx.ui.input("Jira password or API token:", "");
            if (!pass) return;
            profile = { name: name.trim(), auth: "basic", username, pass };
          }
          const users = [...(config?.users ?? []), profile];
          await saveConfig({
            ...(config ?? { url, ...profile }),
            ...profile,
            url,
            users,
            profileName: config?.profileName ?? profile.name,
            defaultUser: config?.defaultUser ?? profile.name,
          });
          if (!config) activeJiraProfileName = profile.name;
          ctx.ui.notify(`Added Jira user ${profile.name}${config ? "" : " and set it as the default"}.`, "info");
          return;
        }

        const users = config!.users ?? [];
        if (users.length === 0) throw new Error("No Jira user profiles are configured");
        const currentUser = config!.profileName ?? config!.defaultUser ?? users[0].name;
        const selected = await chooseJiraItem(
          ctx,
          `Select a Jira user (current: ${currentUser})`,
          users,
          (item) => `${item.name} — ${item.auth === "bearer" ? "API key" : item.username}`
            + (item.name === currentUser ? " [current]" : "")
            + (item.name === config!.defaultUser ? " [default]" : ""),
        );
        if (!selected) return;

        if (action === "change" || action === "change user") {
          activeJiraProfileName = selected.name;
          ctx.ui.notify(`Jira user changed for this Pi session to ${selected.name}.`, "info");
          return;
        }
        if (action === "set default" || action === "set default user") {
          activeJiraProfileName = selected.name;
          await saveConfig({ ...config!, defaultUser: selected.name, profileName: selected.name });
          ctx.ui.notify(`Jira default user set to ${selected.name}.`, "info");
          return;
        }
        throw new Error("Use /jira-user add user, /jira-user change user, or /jira-user set default user");
      } catch (error) {
        ctx.ui.notify(`Jira user: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("jira-add-config", {
    description: "Configure the Jira project, issue type, and limited assignee list used by /jira-add",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(`Run /jira-add-config in interactive mode (config: ${configPath})`, "error");
        return;
      }
      try {
        const existing = await loadConfig();
        if (!existing) throw new Error(`Jira is not configured. Run /config-jira first (config: ${configPath})`);
        const projects = await listProjects(existing);
        if (projects.length === 0) throw new Error("No Jira projects are available to your account");
        const project = await chooseJiraItem(
          ctx,
          "Select the Jira project for /jira-add",
          projects,
          (item) => `${item.key} — ${item.name}`,
        );
        if (!project) return;
        const projectKey = project.key;
        const issueTypes = await listIssueTypes(existing, projectKey);
        if (issueTypes.length === 0) throw new Error(`No issue types are available in Jira project ${projectKey}`);
        const issueType = await chooseJiraItem(
          ctx,
          "Select the Jira issue type for /jira-add",
          issueTypes,
          (item) => item.name,
        );
        if (!issueType) return;
        const availableUsers = (await listAssignableUsers(existing, projectKey))
          .filter((user) => user.active !== false && userIdentifier(user));
        if (availableUsers.length === 0) throw new Error(`No assignable Jira users were found for project ${projectKey}`);
        const existingAssignees = new Set((existing.jiraAddAssignees ?? []).map((item) => item.toLowerCase()));
        const selectedUsers = await chooseJiraUsers(ctx, availableUsers, existingAssignees);
        if (!selectedUsers) return;
        if (selectedUsers.length === 0) {
          ctx.ui.notify("Select at least one allowed assignee.", "warning");
          return;
        }
        const jiraAddAssignees = selectedUsers.flatMap((user) =>
          [user.name, user.key, user.accountId, user.emailAddress, user.displayName]
            .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
            .slice(0, 1),
        );
        await saveConfig({
          ...existing,
          jiraAddProjectKey: projectKey.trim(),
          jiraAddIssueType: issueType.name,
          jiraAddAssignees,
        });
        ctx.ui.notify(
          `Jira add configuration saved: project ${projectKey.trim()}, type ${issueType.name}, ${jiraAddAssignees.length} allowed assignee${jiraAddAssignees.length === 1 ? "" : "s"}.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`Jira add configuration: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("jira-see", {
    description: "Show tasks assigned to me in the current Jira sprint",
    handler: async (_args, ctx) => {
      try {
        const result = await getTasks();
        if (ctx.hasUI) ctx.ui.notify(result.text, "info");
        else console.log(result.text);
      } catch (error) {
        ctx.ui.notify(`Jira: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("jira-add", {
    description: "Create a Jira task from a description and interactively choose its project, type, and assignee",
    handler: async (args, ctx) => {
      try {
        if (!ctx.hasUI) throw new Error("/jira-add requires interactive mode");
        const description = args.trim() || await ctx.ui.editor("Jira task description:", "");
        if (!description?.trim()) return;
        const issue = await addJiraTask(description.trim(), ctx);
        if (issue) ctx.ui.notify(`Created Jira task ${issue.key}: ${issue.url}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Jira task creation: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("jira-start", {
    description: "Select a Jira task and repository, then open VS Code in the main checkout and an Orca terminal in a worktree",
    handler: async (_args, ctx) => {
      try {
        if (!ctx.hasUI) throw new Error("/jira-start requires interactive mode");
        const result = await getTasks();
        const taskOptions = (result.issues ?? []).map((issue) => ({
          name: issue.key,
          description: `${issue.fields?.status?.name ?? "Unknown status"} — ${issue.fields?.summary ?? "(no summary)"}`,
          issue,
        }));
        const task = await choose(ctx, "Select a Jira task", taskOptions);
        if (!task) return;
        const agent = await choose(ctx, "Select an agent", DEVELOPMENT_AGENTS);
        if (!agent) return;
        const repositories = await loadRepositories();
        if (repositories.length === 0) throw new Error("No repositories registered in Orca");
        const repository = await choose(ctx, "Select a repository", repositories);
        if (!repository) return;
        // Switch to Orca's desktop before creating the worktree and terminal.
        await switchToDesktopTwo();
        const prepared = await prepareRepository(
          ctx,
          repository.path,
          task.issue.fields?.summary ?? "(no task summary provided)",
        );
        // Keep VS Code attached to the main checkout; the agent terminal is
        // opened separately in the clean Orca-managed worktree.
        await launchDetached("code", ["--new-window", prepared.mainPath]);
        await openInTools(prepared.worktreePath, agent, taskPrompt(result.config!, task.issue));
        ctx.ui.notify(
          `Started ${agent.name} in worktree ${prepared.worktreePath}; VS Code opened in ${prepared.mainPath}. Prompt is ready to edit; press Enter when ready.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`Jira workflow: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "jira_add_task",
    label: "Add Jira Task",
    description: "Create a Jira task from a description. In interactive mode, fetches assignable users and lets the user choose the project, issue type, and assignee before creation.",
    parameters: Type.Object({
      description: Type.String({ description: "The full Jira task description. The first non-empty line is used as the summary." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      if (!ctx.hasUI) throw new Error("Adding a Jira task requires interactive mode");
      const issue = await addJiraTask(params.description.trim(), ctx);
      if (!issue) return { content: [{ type: "text", text: "Jira task creation cancelled." }], details: { cancelled: true } };
      return {
        content: [{ type: "text", text: `Created Jira task ${issue.key}: ${issue.url}` }],
        details: { key: issue.key, url: issue.url },
      };
    },
  });

  pi.registerTool({
    name: "jira_current_sprint",
    label: "Jira Current Sprint",
    description: "List Jira tasks assigned to the authenticated user in the current/open sprint.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx: ExtensionContext) {
      try {
        const result = await getTasks();
        return { content: [{ type: "text", text: result.text }], details: { issues: result.issues ?? [] } };
      } catch (error) {
        return { content: [{ type: "text", text: `Jira error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  });
}
