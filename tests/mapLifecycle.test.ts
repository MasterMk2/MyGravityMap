import { describe, expect, it, vi } from 'vitest'
import type { IControl, Map as MapLibreMap } from 'maplibre-gl'
import type { MapboxOverlay } from '@deck.gl/mapbox'
import { mountMap } from '../src/map/mapLifecycle'
import type { MapStatus } from '../src/map/mapSession'

function fixture() {
  const handlers = new Map<string, Set<(event: never) => void>>()
  const controls = new Set<IControl>()
  const control = () => ({ onAdd: vi.fn(() => ({} as HTMLElement)), onRemove: vi.fn() })
  const nav = control()
  const scale = control()
  let overlayError = () => undefined as void
  const overlay = { ...control(), finalize: vi.fn(() => { controls.delete(overlay) }) }
  const map = {
    on: vi.fn((name: string, handler: (event: never) => void) => {
      if (!handlers.has(name)) handlers.set(name, new Set())
      handlers.get(name)!.add(handler)
    }),
    off: vi.fn((name: string, handler: (event: never) => void) => handlers.get(name)?.delete(handler)),
    addControl: vi.fn((value: IControl) => { value.onAdd(map as unknown as MapLibreMap); controls.add(value) }),
    hasControl: (value: IControl) => controls.has(value),
    removeControl: (value: IControl) => { value.onRemove(map as unknown as MapLibreMap); controls.delete(value) },
    remove: vi.fn(),
  }
  const states: MapStatus[] = []
  let liveMap: MapLibreMap | null = null
  let liveOverlay: MapboxOverlay | null = null
  const options: Parameters<typeof mountMap>[0] = {
    supported: () => true,
    createMap: vi.fn(() => map as unknown as MapLibreMap),
    createNavigation: () => nav,
    createScale: () => scale,
    createOverlay: handler => { overlayError = handler; return overlay as unknown as MapboxOverlay },
    onMap: value => { liveMap = value },
    onOverlay: value => { liveOverlay = value },
    onStatus: value => states.push(value),
    clearContainer: vi.fn(), syncAttribution: vi.fn(), addBuildings: vi.fn(),
    onMove: vi.fn(), onUserPan: vi.fn(),
  }
  const emit = (name: string, event = {}) => {
    for (const handler of [...handlers.get(name) ?? []]) handler(event as never)
  }
  return { map, nav, scale, overlay, controls, handlers, states, options, emit,
    failOverlay: () => overlayError(), refs: () => ({ liveMap, liveOverlay }) }
}

describe('MapLibre/deck lifecycle integration', () => {
  it('constructs nothing on unsupported WebGL2', () => {
    const f = fixture(); f.options.supported = () => false
    mountMap(f.options)
    expect(f.options.createMap).not.toHaveBeenCalled()
    expect(f.map.addControl).not.toHaveBeenCalled()
    expect(f.states.at(-1)).toEqual({ phase: 'failed', reason: 'unsupported' })
  })
  it('contains map constructor failures and clears partial DOM', () => {
    const f = fixture(); f.options.createMap = () => { throw new Error('init failed') }
    expect(() => mountMap(f.options)).not.toThrow()
    expect(f.options.clearContainer).toHaveBeenCalledOnce()
    expect(f.map.addControl).not.toHaveBeenCalled()
    expect(f.refs()).toEqual({ liveMap: null, liveOverlay: null })
  })
  it('catches ScaleControl failure and removes the partially initialized controls', () => {
    const f = fixture(); f.scale.onAdd.mockImplementation(() => { throw new TypeError('unproject') })
    mountMap(f.options)
    expect(f.nav.onRemove).toHaveBeenCalledOnce()
    expect(f.scale.onRemove).toHaveBeenCalledOnce()
    expect(f.overlay.finalize).not.toHaveBeenCalled()
    expect(f.map.remove).toHaveBeenCalledOnce()
    expect(f.refs()).toEqual({ liveMap: null, liveOverlay: null })
    expect(f.states.at(-1)).toEqual({ phase: 'failed', reason: 'initialization' })
  })
  it('handles asynchronous startup errors and unregisters listeners before map.remove', async () => {
    const f = fixture(); mountMap(f.options)
    f.emit('error', { error: new Error('style initialization failed') })
    await Promise.resolve()
    expect(f.states.at(-1)).toEqual({ phase: 'failed', reason: 'initialization' })
    expect([...f.handlers.values()].every(set => set.size === 0)).toBe(true)
    expect(f.overlay.finalize).toHaveBeenCalledOnce()
    expect(f.map.remove).toHaveBeenCalledOnce()
    expect(f.refs()).toEqual({ liveMap: null, liveOverlay: null })
  })
  it('handles a synchronous addControl error event without continuing setup or leaking controls', () => {
    const f = fixture()
    f.scale.onAdd.mockImplementation(() => { f.emit('error', { error: new Error('GPU') }); return {} as HTMLElement })
    mountMap(f.options)
    expect(f.controls.size).toBe(0)
    expect(f.overlay.finalize).not.toHaveBeenCalled()
    expect(f.scale.onRemove).toHaveBeenCalledOnce()
  })
  it('supports normal load, movement, user gestures and style changes before clean unmount', () => {
    const f = fixture(); const session = mountMap(f.options)
    expect(f.controls.size).toBe(3)
    f.emit('load'); f.emit('move'); f.emit('style.load')
    f.emit('dragstart'); f.emit('zoomstart', { originalEvent: {} })
    expect(f.states.at(-1)).toEqual({ phase: 'ready' })
    expect(f.options.onMove).toHaveBeenCalledOnce()
    expect(f.options.onUserPan).toHaveBeenCalledOnce()
    expect(f.options.addBuildings).toHaveBeenCalledOnce()
    f.emit('error', { error: new Error('one tile request failed') })
    expect(session.active).toBe(true)
    session.dispose(); session.dispose()
    expect(f.map.remove).toHaveBeenCalledOnce()
    expect(f.controls.size).toBe(0)
    expect(f.refs()).toEqual({ liveMap: null, liveOverlay: null })
  })
  it('reports asynchronous deck and context failures without exposing a live render handle', async () => {
    for (const failure of ['deck', 'context']) {
      const f = fixture(); mountMap(f.options); f.emit('load')
      if (failure === 'deck') f.failOverlay()
      else f.emit('webglcontextlost')
      await Promise.resolve()
      expect(f.states.at(-1)).toEqual({ phase: 'failed', reason: 'rendering' })
      expect(f.refs()).toEqual({ liveMap: null, liveOverlay: null })
      expect(f.map.remove).toHaveBeenCalledOnce()
    }
  })
  it('contains late events across repeated retry and unmount cycles', () => {
    const first = fixture(); const old = mountMap(first.options)
    const staleLoad = [...first.handlers.get('load')!][0]!
    const staleError = [...first.handlers.get('error')!][0]!
    old.dispose()
    const second = fixture(); const current = mountMap(second.options); second.emit('load')
    staleLoad({} as never); staleError({ error: new Error('GPU') } as never)
    expect(second.states.at(-1)).toEqual({ phase: 'ready' })
    expect(current.active).toBe(true)
    expect(first.states).toEqual([{ phase: 'loading' }])
    current.dispose()
    expect(second.map.remove).toHaveBeenCalledOnce()
  })
})
