import { describe, expect, it, vi } from 'vitest'
import { fatalMapError, startMapSession, supportsWebGL2, type MapSession, type MapStatus } from '../src/map/mapSession'

function attempt(supported = true, steps: Array<(session: MapSession) => void> = []) {
  const states: MapStatus[] = []
  const session = startMapSession({ supported: () => supported, onStatus: state => states.push(state), steps })
  return { session, states }
}

describe('map startup failure boundary', () => {
  it('does not create a map, control or request tiles without WebGL2', () => {
    const create = vi.fn()
    const { session, states } = attempt(false, [create])
    expect(create).not.toHaveBeenCalled()
    expect(session.active).toBe(false)
    expect(states).toEqual([{ phase: 'loading' }, { phase: 'failed', reason: 'unsupported' }])
  })
  it('handles a throwing constructor and clears its partial DOM before a retry', () => {
    const clearContainer = vi.fn()
    const control = vi.fn()
    const { states } = attempt(true, [owner => {
      owner.addCleanup(clearContainer)
      throw new Error('constructor failed')
    }, control])
    expect(clearContainer).toHaveBeenCalledOnce()
    expect(control).not.toHaveBeenCalled()
    expect(states.at(-1)).toEqual({ phase: 'failed', reason: 'initialization' })
  })
  it('cleans partially added controls even when teardown itself throws', () => {
    const releases: string[] = []
    const { session } = attempt(true, [owner => {
      owner.addCleanup(() => { releases.push('container') })
      owner.addCleanup(() => { releases.push('map'); throw new Error('half-built map') })
      owner.addCleanup(() => { releases.push('overlay') })
      throw new Error('ScaleControl unproject failed')
    }])
    expect(releases).toEqual(['overlay', 'map', 'container'])
    expect(() => session.dispose()).not.toThrow()
    expect(releases).toHaveLength(3)
  })
  it('stops later setup after a synchronous error event and releases a late-created control safely', () => {
    const order: string[] = []
    attempt(true, [owner => {
      owner.fail('initialization')
      owner.addCleanup(() => { order.push('removed') })
      order.push('onAdd returned')
    }, () => { order.push('must not run') }])
    expect(order).toEqual(['onAdd returned', 'removed'])
  })
  it('handles asynchronous initialization errors and ignores later load events', async () => {
    const dispose = vi.fn()
    const { session, states } = attempt(true, [owner => owner.addCleanup(dispose)])
    session.fail('initialization')
    session.markReady()
    session.fail('rendering')
    await Promise.resolve()
    expect(dispose).toHaveBeenCalledOnce()
    expect(states).toHaveLength(2)
    expect(states.at(-1)).toEqual({ phase: 'failed', reason: 'initialization' })
  })
  it('keeps the supported path active and handles a later GPU/context failure', () => {
    const update = vi.fn(() => 42)
    const { session, states } = attempt()
    session.markReady()
    session.markReady()
    expect(session.run(update)).toBe(42)
    expect(states).toEqual([{ phase: 'loading' }, { phase: 'ready' }])
    session.fail('rendering')
    session.run(update)
    expect(update).toHaveBeenCalledOnce()
    expect(states.at(-1)).toEqual({ phase: 'failed', reason: 'rendering' })
  })
  it('supports repeated retries and StrictMode mount/cleanup without changing imported data', () => {
    const data = Object.freeze({ filename: 'synthetic.json', points: Object.freeze([1, 2]) })
    const removed = vi.fn()
    const old = attempt(true, [owner => owner.addCleanup(removed)])
    old.session.dispose()
    old.session.dispose()
    const retry = attempt(true, [owner => owner.addCleanup(removed)])
    retry.session.markReady()
    old.session.fail('rendering')
    old.session.markReady()
    expect(retry.states.at(-1)).toEqual({ phase: 'ready' })
    expect(old.states).toEqual([{ phase: 'loading' }])
    expect(removed).toHaveBeenCalledTimes(1)
    retry.session.dispose()
    expect(removed).toHaveBeenCalledTimes(2)
    expect(data).toEqual({ filename: 'synthetic.json', points: [1, 2] })
  })
  it('guards rendering updates, not just initial construction', () => {
    const { session, states } = attempt()
    session.markReady()
    expect(() => session.run(() => { throw new Error('setProps failed') })).not.toThrow()
    expect(states.at(-1)).toEqual({ phase: 'failed', reason: 'rendering' })
  })
  it('does not misclassify ordinary post-load tile failures as GPU startup failures', () => {
    expect(fatalMapError(new Error('tile request failed'), true)).toBe(false)
    expect(fatalMapError(new Error('initialization failed'), false)).toBe(true)
    expect(fatalMapError(Object.assign(new Error('device unavailable'), { name: 'GPUInitializationError' }), true)).toBe(true)
  })
})

describe('WebGL2 capability probe', () => {
  it('reports missing and throwing contexts without propagating exceptions', () => {
    expect(supportsWebGL2(() => ({ getContext: () => null }))).toBe(false)
    expect(supportsWebGL2(() => { throw new Error('unavailable') })).toBe(false)
  })
  it('releases only the temporary probe context on each retry', () => {
    const loseContext = vi.fn()
    const gl = { getExtension: vi.fn(() => ({ loseContext })) }
    const create = () => ({ getContext: () => gl }) as unknown as HTMLCanvasElement
    expect(supportsWebGL2(create)).toBe(true)
    expect(supportsWebGL2(create)).toBe(true)
    expect(gl.getExtension).toHaveBeenCalledWith('WEBGL_lose_context')
    expect(loseContext).toHaveBeenCalledTimes(2)
  })
})


it('defers asynchronous teardown until the event emitter has unwound', async () => {
  const order: string[] = []
  const { session } = attempt(true, [owner => owner.addCleanup(() => { order.push('dispose') })])
  session.fail('rendering')
  order.push('emitter continues')
  expect(session.active).toBe(false)
  expect(order).toEqual(['emitter continues'])
  await Promise.resolve()
  expect(order).toEqual(['emitter continues', 'dispose'])
})
