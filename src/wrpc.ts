// A node over wRPC JSON, in plain TypeScript over a WebSocket, for an integrator with no Kaspa
// client already.
//
// Kaspa's wRPC serves two encodings. Borsh is the efficient one every wallet uses, and it is the
// wrong target for a hand-written client. Its methods travel as numeric ids and every message
// type carries its own version prologue. JSON is string-keyed serde with no prologues, so a
// hand-written client is small and needs no corpus to keep it honest.
//
// A node serves JSON only when you start it with `--rpclisten-json` (testnet-10 default port
// 18210).

import { txNodeOverWrpc } from './adapters.js'
import type { NodeCallOptions } from '@dotk/sdk'
import type { TxNode } from './ports.js'

/** One request in flight. The envelope answers with the same `id` this client sent. */
interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

/** How long one call waits before this client abandons it. A node can hold a socket open and say nothing. */
export const DEFAULT_CALL_TIMEOUT_MS = 20_000

/** How long {@link WrpcJson.connect} waits for the socket to open, when the caller sets nothing. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000

/** What {@link WrpcJson.connect} can be told. */
export interface ConnectOptions {
  /** How long the socket can take to open, in milliseconds. */
  timeoutMs?: number | undefined
  /** How long each call can take, in milliseconds. */
  callTimeoutMs?: number | undefined
}

export class WrpcJson {
  private next = 1
  private readonly pending = new Map<number, Pending>()

  private constructor(
    private readonly ws: WebSocket,
    private readonly callTimeoutMs: number
  ) {
    ws.onmessage = (event) => {
      let body: { id?: number; params?: unknown; error?: unknown }
      try {
        body = JSON.parse(String(event.data)) as typeof body
      } catch {
        return // not an answer to anything, only a frame this client did not ask for
      }
      const waiting = body.id === undefined ? undefined : this.pending.get(body.id)
      if (!waiting) return
      this.pending.delete(body.id!)
      if (body.error !== undefined) waiting.reject(new Error(JSON.stringify(body.error)))
      else waiting.resolve(body.params)
    }
    ws.onclose = () => {
      for (const waiting of this.pending.values()) waiting.reject(new Error('the node closed the connection'))
      this.pending.clear()
    }
  }

  static connect(url: string, options?: ConnectOptions): Promise<WrpcJson> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    const callTimeoutMs = options?.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      const timer = setTimeout(() => reject(new Error(`${url} did not answer within ${timeoutMs}ms`)), timeoutMs)
      ws.onopen = () => {
        clearTimeout(timer)
        resolve(new WrpcJson(ws, callTimeoutMs))
      }
      ws.onerror = () => {
        clearTimeout(timer)
        reject(new Error(`${url} refused the connection`))
      }
    })
  }

  call(method: string, params: unknown = {}, options?: NodeCallOptions): Promise<unknown> {
    const id = this.next++
    return new Promise((resolve, reject) => {
      if (options?.signal?.aborted) {
        reject(options.signal.reason as Error)
        return
      }
      // The callback resolves `give` when it fires, which is after this block ran.
      const timer = setTimeout(
        () => give(new Error(`the node did not answer ${method} within ${this.callTimeoutMs}ms`)),
        this.callTimeoutMs
      )
      const give = (reason: Error) => {
        // The timer too, because an abandoned one holds a Node process open for its whole
        // duration. The listener too, or a caller's long-lived signal keeps one per abandoned call.
        clearTimeout(timer)
        options?.signal?.removeEventListener('abort', relay)
        this.pending.delete(id)
        reject(reason)
      }
      const relay = () => give(options!.signal!.reason as Error)
      options?.signal?.addEventListener('abort', relay, { once: true })
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          options?.signal?.removeEventListener('abort', relay)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          options?.signal?.removeEventListener('abort', relay)
          reject(e)
        },
      })
      this.ws.send(encodeRequest(id, method, params))
    })
  }

  close(): void {
    this.ws.close()
  }
}

/**
 * One request, with every bigint written as a JSON number.
 *
 * `JSON.stringify` refuses a bigint outright, and converting to a number first rounds an amount
 * above 2^53 into one the signature does not commit to. JSON itself has no such limit, so this
 * encoder puts the digits back after stringify quoted them.
 */
export function encodeRequest(id: number, method: string, params: unknown): string {
  for (let width = 1; ; width += 1) {
    // A marker no string in this body already carries, so only the quotes this encoder wrote are
    // removed. The replacer sees every string, so a collision is found and not guessed at, and
    // the tag grows until none remains.
    const tag = `@${'~'.repeat(width)}bigint:`
    const marks = new Set<string>()
    // Assigned inside the replacer, which the checker cannot see run, so it reads as never set.
    let collided = false as boolean
    const body = JSON.stringify({ id, method, params }, (_key, value: unknown) => {
      if (typeof value === 'string' && value.startsWith(tag)) collided = true
      if (typeof value !== 'bigint') return value
      const mark = `${tag}${value.toString()}@`
      marks.add(mark)
      return mark
    })
    if (collided) continue
    let out = body
    for (const mark of marks) out = out.split(`"${mark}"`).join(mark.slice(tag.length, -1))
    return out
  }
}

/**
 * A {@link TxNode} over one JSON connection: {@link txNodeOverWrpc} bound to this client.
 *
 * Give `network` (`dotk.network`) and the first call confirms the node is on it.
 */
export function nodeOver(rpc: WrpcJson, network?: string): TxNode {
  return txNodeOverWrpc((method, params, options) => rpc.call(method, params, options), network)
}
