/** Sanitized Hook ledger. Tool content is never read here. */
export interface ApprovalTurn {
  sessionId: string;
  turnId: string;
  at: number;
  activityAt: number;
  pending: Map<string, { count: number; at: number }>;
}
export interface ApprovalLedger { turns: Map<string, ApprovalTurn>; cleared: Map<string, number>; overflow: boolean }
export const emptyApprovals = (): ApprovalLedger => ({ turns: new Map(), cleared: new Map(), overflow: false });
export const approvalId = (sessionId: string, turnId: string): string => JSON.stringify([sessionId, turnId]);
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value);

export function reduceApproval(state: ApprovalLedger, line: string, now: number, timeout: number): ApprovalLedger {
  if (state.overflow) return state;
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(line); } catch { return state; }
  if (!raw || typeof raw !== 'object' || raw.version !== 1 || !id(raw.sessionId) ||
    typeof raw.at !== 'number' || !Number.isFinite(raw.at) || raw.at <= 0 || raw.at > now + 5000 ||
    !['approval_requested', 'tool_returned', 'clear'].includes(String(raw.event))) return state;
  const turns = new Map(state.turns);
  const cleared = new Map(state.cleared);
  for (const [key, at] of cleared) if (now - at > timeout) cleared.delete(key);
  for (const [key, turn] of turns) if (!turn.pending.size && now - turn.at > timeout) turns.delete(key);
  if (raw.event === 'clear' && raw.scope === 'session') {
    const key = approvalId(raw.sessionId, '*');
    if (!cleared.has(key) && cleared.size >= 128) return { ...state, overflow: true };
    cleared.set(key, Math.max(cleared.get(key) ?? 0, raw.at));
    for (const [key, turn] of turns) if (turn.sessionId === raw.sessionId && raw.at >= turn.at) turns.delete(key);
    return { ...state, turns, cleared };
  }
  if (!id(raw.turnId)) return state;
  const key = approvalId(raw.sessionId, raw.turnId);
  const previous = turns.get(key);
  if ((previous && raw.at < previous.at) || raw.at < Math.max(cleared.get(key) ?? 0, cleared.get(approvalId(raw.sessionId, '*')) ?? 0)) return state;
  if (raw.event === 'clear') {
    if (raw.scope !== 'turn') return state;
    turns.delete(key);
    if (!cleared.has(key) && cleared.size >= 128) return { ...state, overflow: true };
    cleared.set(key, raw.at);
    return { ...state, turns, cleared };
  }
  if (typeof raw.toolKey !== 'string' || !/^[a-f0-9]{64}$/.test(raw.toolKey)) return state;
  if (raw.event === 'approval_requested' && now - raw.at > timeout) return state;
  if (raw.event === 'tool_returned' && !previous?.pending.has(raw.toolKey)) return state;
  if (!previous && turns.size >= 128) return { ...state, overflow: true };
  const turn: ApprovalTurn = previous ? { ...previous, pending: new Map(previous.pending), at: raw.at }
    : { sessionId: raw.sessionId, turnId: raw.turnId, at: raw.at, activityAt: 0, pending: new Map() };
  const item = turn.pending.get(raw.toolKey);
  if (raw.event === 'approval_requested' && ((!item && turn.pending.size >= 128) || (item && item.count >= 128))) return { ...state, overflow: true };
  if (raw.event === 'approval_requested') turn.pending.set(raw.toolKey, { count: (item?.count ?? 0) + 1, at: item?.at ?? raw.at });
  else {
    if (item!.count > 1) turn.pending.set(raw.toolKey, { ...item!, count: item!.count - 1 });
    else turn.pending.delete(raw.toolKey);
    turn.activityAt = raw.at;
  }
  turns.set(key, turn);
  return { ...state, turns, cleared };
}
