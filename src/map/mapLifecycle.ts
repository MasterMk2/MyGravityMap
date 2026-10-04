import type { IControl, Map as MapLibreMap } from 'maplibre-gl'
import type { MapboxOverlay } from '@deck.gl/mapbox'
import { fatalMapError, startMapSession, type MapStatus, type MapSession } from './mapSession'

/** Adapter kept outside React so construction, error events and partial teardown are testable. */
export function mountMap(options: {
  supported: () => boolean
  createMap: () => MapLibreMap
  createNavigation: () => IControl
  createScale: () => IControl
  createOverlay: (onError: () => void) => MapboxOverlay
  onMap: (map: MapLibreMap | null) => void
  onOverlay: (overlay: MapboxOverlay | null) => void
  onStatus: (status: MapStatus) => void
  clearContainer: () => void
  syncAttribution: (map: MapLibreMap) => void
  addBuildings: (map: MapLibreMap) => void
  onMove: (map: MapLibreMap) => void
  onUserPan: () => void
}) {
  let map: MapLibreMap
  let overlay: MapboxOverlay
  return startMapSession({
    supported: options.supported,
    onStatus: options.onStatus,
    steps: [
      owner => {
        owner.addCleanup(options.clearContainer)
        map = options.createMap()
        owner.addCleanup(() => map.remove())
        // Clear refs even if a subsequent configuration or cleanup method throws.
        owner.addCleanup(() => { options.onMap(null); options.onOverlay(null) })
        options.onMap(map)
        const handleError = (event: { error: unknown }) => {
          if (fatalMapError(event.error, owner.ready)) owner.fail(owner.ready ? 'rendering' : 'initialization')
        }
        const handleLoad = () => owner.markReady()
        const handleContextLost = () => owner.fail('rendering')
        map.on('error', handleError)
        owner.addCleanup(() => map.off('error', handleError))
        map.on('load', handleLoad)
        owner.addCleanup(() => map.off('load', handleLoad))
        map.on('webglcontextlost', handleContextLost)
        owner.addCleanup(() => map.off('webglcontextlost', handleContextLost))
      },
      ...([['createNavigation', 'top-right'], ['createScale', 'bottom-left']] as const).map(([factory, position]) =>
        (owner: MapSession) => {
          const control = options[factory]()
          owner.addCleanup(() => {
            if (map.hasControl(control)) map.removeControl(control)
            else control.onRemove(map) // also attempt cleanup if onAdd threw before registration
          })
          map.addControl(control, position)
        }),
      owner => {
        overlay = options.createOverlay(() => owner.fail('rendering'))
        owner.addCleanup(() => overlay.finalize())
        options.onOverlay(overlay)
        map.addControl(overlay)
      },
      () => options.syncAttribution(map),
      owner => {
        const handleStyleLoad = () => owner.run(() => {
          if (!map.hasControl(overlay)) map.addControl(overlay)
          options.addBuildings(map)
        })
        map.on('style.load', handleStyleLoad)
        owner.addCleanup(() => map.off('style.load', handleStyleLoad))
        const handleMove = () => owner.run(() => options.onMove(map))
        map.on('move', handleMove)
        owner.addCleanup(() => map.off('move', handleMove))
        const handleUserPan = (event: { originalEvent?: unknown }) => owner.run(() => {
          if (event.originalEvent) options.onUserPan()
        })
        map.on('dragstart', handleUserPan)
        owner.addCleanup(() => map.off('dragstart', handleUserPan))
        map.on('zoomstart', handleUserPan)
        owner.addCleanup(() => map.off('zoomstart', handleUserPan))
      },
    ],
  })
}
