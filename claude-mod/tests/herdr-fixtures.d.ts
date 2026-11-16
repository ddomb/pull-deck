type Replay = { state: unknown; replies: { query: string; data: { status: string; prIds: string[]; stale: boolean } }[] }
export const live: Replay
export const fifty: Replay
