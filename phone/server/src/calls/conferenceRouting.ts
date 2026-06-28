/**
 * Pure turn-routing logic for multi-party calls (911 war room + conferences).
 * No I/O — the hub feeds it the transcript and the current roster and acts on
 * the result. Kept separate so kick parsing and lead policy are unit-testable.
 */

export type CallAgent = { extension: string; name: string };

export type KickCommand = { action: "kick"; target: CallAgent };

/** Normalize for name matching: lowercase, strip punctuation/emoji noise. */
function norm(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** First word of an agent's display name ("Echo (built-in test)" → "echo"). */
function shortName(agent: CallAgent): string {
  return norm(agent.name).split(" ")[0] ?? "";
}

/** True when the transcript mentions this agent by name or extension digits. */
function mentions(normalizedText: string, agent: CallAgent): boolean {
  const padded = ` ${normalizedText} `;
  const short = shortName(agent);
  if (short && padded.includes(` ${short} `)) return true;
  return padded.includes(` ${agent.extension} `);
}

/**
 * Detect a spoken kick command: "kick codex", "drop hermes", "remove claude",
 * "claude, leave". Matched against the CURRENT participants only, so "kick my
 * bad habit" can't eject anyone. Returns null when the turn isn't a kick.
 *
 * STT robustness: "kick" is a short plosive the recognizer sometimes hears as
 * "kik"/"click" — those count too (a real sentence starting with
 * "click <participant name>" is vanishingly unlikely mid-call; "pick" is NOT
 * accepted because "pick Claude for X" is a plausible assignment). The
 * "<name>, leave" form has no leading verb at all, so it survives even when
 * the mic clips the utterance onset.
 */
export function parseKickCommand(text: string, agents: CallAgent[]): KickCommand | null {
  const verb = /^\s*(?:please\s+)?(?:kick|kik|click|drop|remove)\s+(.+?)[.!?]?\s*$/i.exec(text);
  if (verb) {
    const rest = norm(verb[1]);
    for (const agent of agents) {
      if (mentions(rest, agent)) return { action: "kick", target: agent };
    }
  }
  const leave = /^\s*(.+?)[,\s]+(?:please\s+)?(?:leave|leave the call|get out)[.!?]?\s*$/i.exec(text);
  if (leave) {
    // STRICT: the prefix must be EXACTLY the agent's name/extension — nothing
    // else. mentions()-style substring matching here kicked agents on
    // "Codex, don't leave" (negation swallowed into the prefix) and relayed
    // sentences like "Claude, tell Codex to leave". ("you can go" is excluded
    // entirely: it usually means "go ahead", not "hang up".)
    const who = norm(leave[1]);
    for (const agent of agents) {
      if (who === shortName(agent) || who === agent.extension) return { action: "kick", target: agent };
    }
  }
  return null;
}

const EVERYONE_KEYWORDS = [" everyone ", " everybody ", " all of you ", " you all ", " team "];

/**
 * Lead-listens-first turn policy:
 *  1. agents the user NAMES get the turn ("codex, what do you think")
 *  2. else "everyone"/"all of you"/"you all"/"team" → every agent
 *  3. else → just the lead.
 */
export function selectTurnTargets(text: string, input: { lead: string | null; agents: CallAgent[] }): string[] {
  if (input.agents.length === 0) return [];
  const normalized = norm(text);
  const named = input.agents.filter((a) => mentions(normalized, a));
  if (named.length > 0) return named.map((a) => a.extension);
  const padded = ` ${normalized} `;
  if (EVERYONE_KEYWORDS.some((kw) => padded.includes(kw))) {
    return input.agents.map((a) => a.extension);
  }
  const lead = input.lead && input.agents.some((a) => a.extension === input.lead) ? input.lead : input.agents[0].extension;
  return [lead];
}

/**
 * Consecutive agent-authored messages allowed in a group chat before the chain
 * STOPS and waits for a real user turn. This is the ONLY path where an agent's
 * CLI runs without a live user call/text driving that exact turn, so it's a
 * hard token-budget cap: at most this many agent CLI runs per human message.
 * (4 covers "Claude, ask Codex and Copilot to review X" → relay + 2-3 replies.)
 */
export const MAX_AGENT_CHAIN = 4;

/**
 * Routing for GROUP TEXT messages — the text twin of selectTurnTargets, plus
 * controlled agent↔agent relay:
 *
 *  USER message:  named/@'d agents → those · "everyone" → all · else → lead.
 *  AGENT message: ONLY agents it explicitly names (so "Claude, tell Codex X"
 *                 lets Claude write to Codex and Codex answer back) — never a
 *                 lead fallback (every reply would re-trigger the lead → loop),
 *                 and the chain dies after MAX_AGENT_CHAIN consecutive
 *                 agent-authored messages until the user speaks again.
 *
 * "@101" / "@codex" work because norm() strips the @ before matching.
 */
/**
 * Leading vocative: agents addressed at the START of the message ("claude, …",
 * "hey codex and copilot, …"). When present, ONLY they take the turn — names
 * later in the sentence are subjects, not recipients ("claude say to codex X"
 * goes to Claude alone; Codex hears about it from Claude's relay).
 */
function leadingVocatives(normalized: string, agents: CallAgent[]): CallAgent[] {
  const words = normalized.split(" ").filter(Boolean);
  let i = 0;
  while (i < words.length && ["hey", "ok", "okay", "yo", "hi"].includes(words[i])) i++;
  const found: CallAgent[] = [];
  while (i < words.length) {
    const agent = agents.find((a) => shortName(a) === words[i] || a.extension === words[i]);
    if (!agent) break;
    if (!found.includes(agent)) found.push(agent);
    i++;
    if (i < words.length && (words[i] === "and" || words[i] === "plus")) i++;
  }
  return found;
}

export function selectGroupTextTargets(input: {
  body: string;
  fromExtension: string;
  fromIsAgent: boolean;
  /** Agent members of the thread, in member order (lead = first). */
  agents: CallAgent[];
  /** Tail run of agent-authored messages in the thread BEFORE this one. */
  consecutiveAgentMessages: number;
  /** Kill switch: when true, agents can NEVER trigger another agent (max token safety). */
  relayDisabled?: boolean;
}): string[] {
  const agents = input.agents.filter((a) => a.extension !== input.fromExtension);
  if (agents.length === 0) return [];
  const normalized = norm(input.body);
  const vocative = leadingVocatives(normalized, agents);
  const named = vocative.length > 0 ? vocative : agents.filter((a) => mentions(normalized, a));
  if (input.fromIsAgent) {
    // An agent message NEVER triggers another agent when relay is disabled, or
    // once the per-human-message chain cap is hit. Either way: zero CLI runs.
    if (input.relayDisabled || input.consecutiveAgentMessages >= MAX_AGENT_CHAIN) return [];
    return named.map((a) => a.extension);
  }
  if (named.length > 0) return named.map((a) => a.extension);
  const padded = ` ${normalized} `;
  if (EVERYONE_KEYWORDS.some((kw) => padded.includes(kw))) {
    return agents.map((a) => a.extension);
  }
  return [agents[0].extension];
}
