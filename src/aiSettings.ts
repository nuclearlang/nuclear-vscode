// The configuration of the AI loop in the editor's settings (`nuclear.ai.*`): where the services answer, the local
// models, Claude's model, the retry policy and the MCP command. The Loop and the chat read it as the machine's
// defaults; a project's `.nuclear/loop.json` still wins (it is shared with CI). Jira's credentials live in the secret
// storage.
import * as vscode from 'vscode';
import { readMachine } from './aiSetup';
import { JiraAuth, LoopConfig, RetryPolicy, toolEnv } from './loopEngine';

export const JIRA_SECRET = 'nuclear.loop.jira';

export interface AiSettings {
  developerUrl: string;
  graphUrl: string;
  ollamaUrl: string;
  coderModel: string;
  assistantModel: string;
  embeddingsModel: string;
  claudeModel: string;
  mcpCommand: string;
  /** The context window of the local models in tokens (the Developer's `numCtx`). */
  contextTokens: number;
  retry: RetryPolicy;
}

export function aiSettings(): AiSettings {
  const c = vscode.workspace.getConfiguration('nuclear.ai');
  // a model the user set in the editor wins; else the one of the profile the set-up installed (ADR-0106)
  const machine = readMachine();
  const model = (key: string, chosen: string | undefined) => {
    const i = c.inspect<string>(key);
    return i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue ?? chosen ?? i?.defaultValue ?? '';
  };
  return {
    developerUrl: c.get('developerUrl', 'http://127.0.0.1:7879'),
    graphUrl: c.get('graphUrl', 'http://127.0.0.1:7878'),
    ollamaUrl: c.get('ollamaUrl', 'http://localhost:11434'),
    coderModel: model('models.coder', machine.CODER_MODEL),
    assistantModel: model('models.assistant', machine.ASSISTANT_MODEL),
    embeddingsModel: model('models.embeddings', machine.NUCLEAR_GRAPH_EMBED),
    claudeModel: c.get('claudeModel', 'sonnet'),
    mcpCommand: c.get('mcpCommand', 'nuclear-graph'),
    contextTokens: c.get('contextTokens', 8192),
    retry: { attempts: c.get('retry.attempts', 5), baseMs: c.get('retry.baseMs', 1000), maxMs: c.get('retry.maxMs', 30000) },
  };
}

/** What the Loop takes from the settings (under a project's `.nuclear/loop.json`). */
export function machineConfig(): Partial<LoopConfig> {
  const s = aiSettings();
  const c = vscode.workspace.getConfiguration('nuclear.ai');
  return {
    developerUrl: s.developerUrl,
    graphUrl: s.graphUrl,
    ollamaUrl: s.ollamaUrl,
    coderModel: s.coderModel,
    assistantModel: s.assistantModel,
    claudeModel: s.claudeModel,
    claudeCommand: c.get('claude.command', 'claude'),
    claudeBudgetUsd: c.get('claude.maxBudgetUsd', 2),
    graphCommand: s.mcpCommand,
    retry: s.retry,
    callTimeoutMs: c.get('watch.callTimeoutMinutes', 15) * 60_000,
    stallSeconds: c.get('watch.stallSeconds', 90),
    minFreeMb: c.get('watch.minFreeMb', 500),
    commandTimeoutMs: c.get('watch.commandTimeoutMinutes', 20) * 60_000,
  };
}

/** The environment the graph and the Developer start with, so they use the models and addresses of the settings. */
export function serviceEnv(): NodeJS.ProcessEnv {
  const s = aiSettings();
  const port = (url: string, fallback: string) => {
    try {
      return new URL(url).port || fallback;
    } catch {
      return fallback;
    }
  };
  return {
    ...toolEnv(),
    CODER_MODEL: s.coderModel,
    ASSISTANT_MODEL: s.assistantModel,
    OLLAMA_URL: s.ollamaUrl,
    NUCLEAR_GRAPH_EMBED: s.embeddingsModel,
    NUCLEAR_GRAPH_URL: s.graphUrl,
    NUCLEAR_GRAPH_PORT: port(s.graphUrl, '7878'),
    NUCLEAR_DEVELOPER_PORT: port(s.developerUrl, '7879'),
  };
}

/** Jira's site, email and token from the secret storage; asked (and kept) when missing or when `ask`. */
export async function jiraAuth(context: vscode.ExtensionContext, ask: boolean): Promise<JiraAuth | undefined> {
  const saved = await context.secrets.get(JIRA_SECRET);
  if (saved && !ask) return JSON.parse(saved) as JiraAuth;
  // the site and the email are settings (nuclear.ai.jira.*); only the token is a secret
  const c = vscode.workspace.getConfiguration('nuclear.ai');
  const baseUrl = c.get('jira.site', '') || (await vscode.window.showInputBox({ title: 'Jira (1/3)', prompt: 'Your Jira site', placeHolder: 'https://your-team.atlassian.net', ignoreFocusOut: true }));
  if (!baseUrl) return undefined;
  const email = c.get('jira.email', '') || (await vscode.window.showInputBox({ title: 'Jira (2/3)', prompt: 'The email of your Atlassian account', ignoreFocusOut: true }));
  if (!email) return undefined;
  await c.update('jira.site', baseUrl, vscode.ConfigurationTarget.Global);
  await c.update('jira.email', email, vscode.ConfigurationTarget.Global);
  const token = await vscode.window.showInputBox({ title: 'Jira (3/3)', prompt: 'An API token (id.atlassian.com → Security → API tokens). Kept in VS Code secret storage.', password: true, ignoreFocusOut: true });
  if (!token) return undefined;
  const criteriaField = c.get('jira.criteriaField', '');
  const auth: JiraAuth = { baseUrl, email, token, criteriaField: criteriaField || undefined };
  await context.secrets.store(JIRA_SECRET, JSON.stringify(auth));
  return auth;
}
