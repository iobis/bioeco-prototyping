import maplibregl, { type StyleSpecification } from 'maplibre-gl'
import { useEffect, useRef } from 'react'

const HIGHLIGHT_SOURCE_ID = 'project-highlight'
const HIGHLIGHT_LAYER_ID = 'project-highlight-layer'

interface MapProps {
  hoveredProjectId?: string | null
}

export function Map({ hoveredProjectId = null }: MapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const hoveredIdRef = useRef<string | null>(null)
  hoveredIdRef.current = hoveredProjectId ?? null

  useEffect(() => {
    if (!containerRef.current) return

    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    const tileUrl = `${origin}/api/tiles/projects/{z}/{x}/{y}.mvt`

    const style = {
      version: 8,
      glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
      sources: {
        'project-tiles': {
          type: 'vector',
          tiles: [tileUrl],
          minzoom: 0,
          maxzoom: 4,
        },
        land_polygons: {
          type: 'vector',
          tiles: ['https://tiles.obis.org/land_tiles/{z}/{x}/{y}.pbf'],
          minzoom: 0,
          maxzoom: 14,
        },
        coastlines: {
          type: 'vector',
          tiles: ['https://tiles.obis.org/coastlines_tiles/{z}/{x}/{y}.pbf'],
          minzoom: 0,
          maxzoom: 14,
        },
      },
      layers: [
        {
          id: 'background',
          type: 'background',
          paint: { 'background-color': '#e8ecf0' },
        },
        {
          id: 'land_polygons',
          type: 'fill',
          source: 'land_polygons',
          'source-layer': 'land',
          paint: {
            'fill-color': '#f8fafc',
            'fill-opacity': 1,
          },
        },
        {
          id: 'coastlines',
          type: 'line',
          source: 'coastlines',
          'source-layer': 'coastlines',
          paint: {
            'line-color': '#334155',
            'line-width': 0.4,
            'line-opacity': 0.85,
          },
        },
        {
          id: 'project-grid',
          type: 'fill',
          source: 'project-tiles',
          'source-layer': 'aggs',
          paint: {
            'fill-color': [
              'interpolate',
              ['linear'],
              ['get', 'unique_projects.value'], 
              0, '#f1f5f9',
              1, '#e8eaef',
              2, '#dde1f5',
              5, '#c4c8e8',
              10, '#9ca3d9',
              20, '#5c6099',
            ],
            'fill-opacity': 0.18,
            'fill-outline-color': 'rgba(255,255,255,0.5)',
          },
        },
        {
          id: 'project-grid-labels',
          type: 'symbol',
          source: 'project-tiles',
          'source-layer': 'aggs',
          layout: {
            'text-field': ['coalesce', ['to-string', ['get', 'unique_projects.value']], '0'],
            'text-size': 7,
            'text-anchor': 'center',
            'symbol-placement': 'point',
            'text-allow-overlap': false,
          },
          paint: {
            'text-color': '#0f172a',
          },
        },
      ],
    } as StyleSpecification

    const map = new maplibregl.Map({
      container: containerRef.current,
      style,
      center: [0, 20],
      zoom: 2,
    })

    map.addControl(new maplibregl.NavigationControl(), 'top-right')
    mapRef.current = map

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.getStyle()) return

    const removeHighlight = () => {
      if (map.getLayer(HIGHLIGHT_LAYER_ID)) map.removeLayer(HIGHLIGHT_LAYER_ID)
      if (map.getSource(HIGHLIGHT_SOURCE_ID)) map.removeSource(HIGHLIGHT_SOURCE_ID)
    }

    if (!hoveredProjectId) {
      removeHighlight()
      return
    }

    const idForFetch = hoveredProjectId
    fetch(`/api/projects/${hoveredProjectId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((project) => {
        if (!mapRef.current || !project?.geometry || hoveredIdRef.current !== idForFetch) {
          removeHighlight()
          return
        }
        removeHighlight()
        const geoJson: GeoJSON.Feature = {
          type: 'Feature',
          geometry: project.geometry,
          properties: {},
        }
        map.addSource(HIGHLIGHT_SOURCE_ID, {
          type: 'geojson',
          data: geoJson,
        })
        map.addLayer(
          {
            id: HIGHLIGHT_LAYER_ID,
            type: 'fill',
            source: HIGHLIGHT_SOURCE_ID,
            paint: {
              'fill-color': '#0284c7',
              'fill-opacity': 0.35,
              'fill-outline-color': '#0369a1',
            },
          },
          'project-grid-labels'
        )
      })
      .catch(() => removeHighlight())

    return removeHighlight
  }, [hoveredProjectId])

  return (
    <div className="map-wrap" style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={containerRef} className="map-container" style={{ width: '100%', height: '100%' }} />
      <div className="map-legend">
        <span className="map-legend-title">Projects per cell</span>
        <div className="map-legend-scale">
          <div className="map-legend-bar">
            <span style={{ background: '#f1f5f9' }} />
            <span style={{ background: '#e8eaef' }} />
            <span style={{ background: '#dde1f5' }} />
            <span style={{ background: '#c4c8e8' }} />
            <span style={{ background: '#9ca3d9' }} />
            <span style={{ background: '#5c6099' }} />
          </div>
          <div className="map-legend-labels">
            <span>0</span>
            <span>1</span>
            <span>5</span>
            <span>20</span>
            <span>100</span>
            <span>500+</span>
          </div>
        </div>
      </div>
    </div>
  )
}
