import maplibregl, { type StyleSpecification } from 'maplibre-gl'
import { useEffect, useRef } from 'react'

export function Map() {
  const containerRef = useRef<HTMLDivElement>(null)

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
              ['get', '_count'],
              0,
              '#f1f5f9',
              1,
              '#e8eaef',
              5,
              '#dde1f5',
              20,
              '#c4c8e8',
              100,
              '#9ca3d9',
              500,
              '#5c6099',
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
            'text-field': ['coalesce', ['to-string', ['get', '_count']], '0'],
            'text-size': 6,
            'text-anchor': 'center',
            'symbol-placement': 'point',
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: {
            'text-color': '#0f172a',
            // 'text-halo-color': 'rgba(255,255,255,0.9)',
            // 'text-halo-width': 1.5,
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

    return () => {
      map.remove()
    }
  }, [])

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
