/** A map attempt owns only rendering resources, never imported data or storage. */
export type MapStatus =
  | { phase: 'loading' }
  | { phase: 'ready' }
  | { phase: 'failed'; reason: 'unsupported' | 'initialization' | 'rendering' }

export interface MapSession {
  readonly active: boolean
  readonly ready: boolean
  run<T>(action: () => T): T | undefined
  addCleanup(cleanup: () => void): void
  markReady(): void
  fail(reason: Extract<MapStatus, { phase: 'failed' }>['reason']): void
  dispose(): void
}

/** Clean up even partially constructed controls. Late events from a previous attempt
 * are ignored; teardown errors cannot prevent the remaining resources being released.
 * Synchronous error events stop subsequent setup steps, but cleanup waits until the
 * in-flight step returns so a control is not removed halfway through its own onAdd.
 */
export function startMapSession(options: {
  supported: () => boolean
  onStatus: (status: MapStatus) => void
  steps: Array<(session: MapSession) => void>
}): MapSession {
  let active = true
  let ready = false
  let depth = 0
  const cleanups: Array<() => void> = []
  const release = () => {
    if (depth) return
    while (cleanups.length) {
      try { cleanups.pop()!() } catch { /* Continue releasing independent resources. */ }
    }
  }
  const session: MapSession = {
    get active() { return active },
    get ready() { return ready },
    run(action) {
      if (!active) return undefined
      depth++
      try { return action() } catch { session.fail(ready ? 'rendering' : 'initialization') }
      finally { depth--; if (!active) release() }
    },
    addCleanup(cleanup) {
      cleanups.push(cleanup)
      if (!active) release()
    },
    markReady() {
      if (!active || ready) return
      ready = true
      options.onStatus({ phase: 'ready' })
    },
    fail(reason) {
      if (!active) return
      active = false
      // Async error handlers may be called in the middle of a renderer's own stack.
      // Invalidate immediately, but let that stack unwind before destroying its map.
      if (depth === 0) queueMicrotask(release)
      options.onStatus({ phase: 'failed', reason })
    },
    dispose() { active = false; release() },
  }
  options.onStatus({ phase: 'loading' })
  session.run(() => {
    if (!options.supported()) session.fail('unsupported')
  })
  for (const step of options.steps) session.run(() => step(session))
  return session
}

/** Probe a temporary context without constructing a map or requesting tiles. */
export function supportsWebGL2(
  createCanvas: () => Pick<HTMLCanvasElement, 'getContext'> = () => document.createElement('canvas'),
): boolean {
  try {
    const gl = createCanvas().getContext('webgl2') as WebGL2RenderingContext | null
    if (!gl) return false
    // Release only this probe's own context, including across repeated Retry clicks.
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch { return false }
}

/** Ordinary tile/network errors after a successful load need not destroy a working map. */
export function fatalMapError(error: unknown, ready: boolean): boolean {
  if (!ready) return true
  return error instanceof Error && (error.name === 'GPUInitializationError' || /WebGL|GPU|context lost/i.test(error.message))
}
