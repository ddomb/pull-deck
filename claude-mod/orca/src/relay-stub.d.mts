export type Asked = { method: string; url: string; body: any }
export type Answer = { status: number; body: unknown }
/** Starts a relay on a fresh socket; without a route, only points the worker at a dead socket. */
export function startRelay(
  route?: (asked: Asked) => Answer | Promise<Answer>,
): Promise<{ hits: string[]; stop(): Promise<void> }>
