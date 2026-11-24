// The few Node APIs the worker uses. The repo carries no @types/node, and Orca's typings cover
// only its own modules.
declare module 'node:http' {
  type Response = {
    statusCode?: number
    setEncoding(encoding: 'utf8'): void
    on(event: 'data', listener: (chunk: string) => void): void
    on(event: 'end' | 'error', listener: () => void): void
  }
  type Request = {
    on(event: 'timeout' | 'error', listener: () => void): void
    destroy(): void
    end(data?: string): void
  }
  export function request(
    options: { socketPath: string; path: string; method: string; headers: Record<string, string>; timeout: number },
    callback: (res: Response) => void,
  ): Request
}

declare const process: { env: Record<string, string | undefined> }
