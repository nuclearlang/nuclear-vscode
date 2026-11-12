// The chat with the local agents, without VS Code: sessions on disk, the history the assistant reads, the templates
// built from the project's map. Drawn by chatPanel.ts.
import * as fs from 'node:fs';
import * as path from 'node:path';

export const CHAT_DIR = path.join('.nuclear', 'chat');
export const HISTORY = 8; // messages of the session the assistant reads
export const MAP_LIMIT = 12000; // characters of the project's map it reads

export interface ChatMessage {
  role: 'you' | 'agent';
  text: string;
  at: number;
  /** A `/task` answer: the run and its journal. */
  run?: string;
  journal?: string;
  failed?: boolean;
  /** What the agent did, shown grey and folded under the answer: its trace, or the steps of a `/task` run. */
  steps?: string[];
  /** How long it took, in seconds. */
  seconds?: number;
  /** The size of the prompt the local model read, in tokens (estimated: characters / 4). */
  tokens?: number;
}

export interface ChatSession {
  id: string;
  title: string;
  created: number;
  messages: ChatMessage[];
}

export interface Template {
  label: string;
  text: string;
}

export function listSessions(root: string): ChatSession[] {
  const dir = path.join(root, CHAT_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        return [JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as ChatSession];
      } catch {
        return [];
      }
    })
    .sort((a, b) => (b.messages.at(-1)?.at ?? b.created) - (a.messages.at(-1)?.at ?? a.created));
}

export function saveSession(root: string, s: ChatSession): void {
  fs.mkdirSync(path.join(root, CHAT_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, CHAT_DIR, `${s.id}.json`), JSON.stringify(s, null, 2));
}

/** The last messages as `you: ...` / `agent: ...` lines, oldest first, each clipped. */
export function historyOf(messages: ChatMessage[]): string {
  return messages
    .slice(-HISTORY)
    .map((m) => `${m.role}: ${m.text.length > 600 ? m.text.slice(0, 600) + ' …' : m.text}`)
    .join('\n');
}

/** Prompts to start from, filled with the project's own names (its map), so the first message is one click away. */
export function templatesOf(map: string, platform: string): Template[] {
  const components = [...map.matchAll(/^## Component `([^`]+)`/gm)].map((m) => m[1]);
  const decl = (kind: string) => map.match(new RegExp(`^\\s+- ${kind} \`([A-Za-z0-9_]+)`, 'm'))?.[1];
  const c = components[0];
  const usecase = decl('usecase');
  const screen = decl('screen') ?? decl('controller');
  const out: Template[] = [];
  if (c) out.push({ label: `Explain ${c}`, text: `Explain the component \`${c}\`: what it does and how its pieces fit together.` });
  if (usecase) out.push({ label: `How ${usecase} works`, text: `How does \`${usecase}\` work, which errors can it return, and who calls it?` });
  if (screen) out.push({ label: `Where ${screen} reads its data`, text: `Where does \`${screen}\` get its data from, step by step?` });
  out.push({ label: 'Add a feature', text: `/task Add to ${c ? `the component \`${c}\`` : 'a new component'} … Acceptance: …` });
  if (usecase) out.push({ label: `Tests of ${usecase}`, text: `/task Write the tests of \`${usecase}\`: the normal case, a missing row and a repeated one.` });
  out.push({ label: 'Fix a bug', text: '/task Fix: when … it does … but it should …' });
  if (c) out.push({ label: `Security of ${c}`, text: `Review the component \`${c}\` for security: validation, guards, secrets, errors that leak.` });
  out.push({ label: `Kinds of ${platform || 'the platform'}`, text: `Which kinds does the ${platform || 'project\'s'} platform have, and when do I use each one?` });
  return out;
}

/** Every question asked in the project's sessions, newest first and without repeats: what ↑ in the input goes
 * through, like a terminal's history. */
export function askedOf(sessions: ChatSession[]): string[] {
  const all = sessions.flatMap((s) => s.messages.filter((m) => m.role === 'you' && !m.text.startsWith('↻')).map((m) => m)).sort((a, b) => b.at - a.at);
  return [...new Set(all.map((m) => m.text))];
}

/** Tokens of a text, estimated the way small models count English and code (about four characters each). */
export function tokensOf(characters: number): number {
  return Math.ceil(characters / 4);
}
