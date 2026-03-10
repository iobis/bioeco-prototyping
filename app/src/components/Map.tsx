import maplibregl, { type StyleSpecification } from 'maplibre-gl'
import { useEffect, useRef, useState } from 'react'
import type { EovVocabulary } from '../eovVocabulary'

const HIGHLIGHT_SOURCE_ID = 'project-highlight'
const HIGHLIGHT_LAYER_ID = 'project-highlight-layer'
const CELL_HIGHLIGHT_SOURCE_ID = 'cell-highlight'
const CELL_HIGHLIGHT_LAYER_ID = 'cell-highlight-layer'
const CELL_HOVER_SOURCE_ID = 'cell-hover'
const CELL_HOVER_LAYER_ID = 'cell-hover-layer'
const PROJECT_GRID_LAYER_ID = 'project-grid'

const EMPTY_GEOJSON: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

/** Get bbox [minLon, minLat, maxLon, maxLat] from a grid cell feature's geometry */
function bboxFromFeatureGeometry(geometry: GeoJSON.Geometry): [number, number, number, number] | null {
  let coords: number[][]
  if (geometry.type === 'Polygon') {
    coords = geometry.coordinates[0]
  } else if (geometry.type === 'MultiPolygon') {
    coords = geometry.coordinates.flat()[0]
  } else {
    return null
  }
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
  for (const c of coords) {
    minLon = Math.min(minLon, c[0])
    maxLon = Math.max(maxLon, c[0])
    minLat = Math.min(minLat, c[1])
    maxLat = Math.max(maxLat, c[1])
  }
  return [minLon, minLat, maxLon, maxLat]
}

export function bboxToString(bbox: [number, number, number, number]): string {
  return bbox.join(',')
}

interface MapProps {
  hoveredProjectId?: string | null
  selectedCellBbox?: string | null
  onCellClick?: (bbox: string | null) => void
  searchQuery?: string
  selectedEovCategories?: string[]
  onEovCategoriesChange?: (keys: string[]) => void
  eovVocabulary?: EovVocabulary | null
}

export function Map({
  hoveredProjectId = null,
  selectedCellBbox = null,
  onCellClick,
  searchQuery = '',
  selectedEovCategories = [],
  onEovCategoriesChange,
  eovVocabulary = null,
}: MapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const mapLoadedRef = useRef(false)
  const [mapReady, setMapReady] = useState(false)
  const lastAppliedSearchRef = useRef<string | undefined>(undefined)
  const hoveredIdRef = useRef<string | null>(null)
  const selectedCellBboxRef = useRef<string | null>(null)
  hoveredIdRef.current = hoveredProjectId ?? null
  selectedCellBboxRef.current = selectedCellBbox ?? null

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

    map.addControl(new maplibregl.NavigationControl(), 'top-left')

    const setupGridInteractions = () => {
      if (!map.getSource(CELL_HOVER_SOURCE_ID)) {
        map.addSource(CELL_HOVER_SOURCE_ID, {
          type: 'geojson',
          data: EMPTY_GEOJSON,
        })
        map.addLayer(
          {
            id: CELL_HOVER_LAYER_ID,
            type: 'fill',
            source: CELL_HOVER_SOURCE_ID,
            paint: {
              'fill-color': '#fde047',
              'fill-opacity': 0.2,
              'fill-outline-color': '#ca8a04',
            },
          },
          'project-grid-labels'
        )
      }

      const hoverSource = map.getSource(CELL_HOVER_SOURCE_ID) as maplibregl.GeoJSONSource | undefined

      const updateHover = (point: maplibregl.Point) => {
        const features = map.queryRenderedFeatures(point, { layers: [PROJECT_GRID_LAYER_ID] })
        if (hoverSource) {
          if (features.length && features[0].geometry) {
            hoverSource.setData({
              type: 'Feature',
              geometry: features[0].geometry as GeoJSON.Polygon,
              properties: {},
            })
          } else {
            hoverSource.setData(EMPTY_GEOJSON)
          }
        }
      }

      map.on('mousemove', (e) => {
        updateHover(e.point)
      })
      map.getCanvas().addEventListener('mouseleave', () => {
        if (hoverSource) hoverSource.setData(EMPTY_GEOJSON)
      })

      if (onCellClick) {
        map.on('click', (e) => {
          const features = map.queryRenderedFeatures(e.point, { layers: [PROJECT_GRID_LAYER_ID] })
          if (features.length && features[0].geometry) {
            const bbox = bboxFromFeatureGeometry(features[0].geometry as GeoJSON.Geometry)
            if (bbox) {
              const bboxStr = bboxToString(bbox)
              const current = selectedCellBboxRef.current
              onCellClick(current === bboxStr ? null : bboxStr)
            }
          }
        })
        map.getCanvas().style.cursor = 'pointer'
      }
    }

    const onLoad = () => {
      mapLoadedRef.current = true
      setMapReady(true)
      setupGridInteractions()
    }
    if (map.isStyleLoaded()) {
      onLoad()
    } else {
      map.once('load', onLoad)
    }

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
        const geometry = project.geometry as GeoJSON.Geometry
        const geoJson: GeoJSON.Feature = {
          type: 'Feature',
          geometry,
          properties: {},
        }
        map.addSource(HIGHLIGHT_SOURCE_ID, {
          type: 'geojson',
          data: geoJson,
        })
        const isAreaGeometry = geometry.type === 'Polygon' || geometry.type === 'MultiPolygon'
        const isLineGeometry = geometry.type === 'LineString' || geometry.type === 'MultiLineString'
        if (isAreaGeometry) {
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
        } else if (isLineGeometry) {
          map.addLayer(
            {
              id: HIGHLIGHT_LAYER_ID,
              type: 'line',
              source: HIGHLIGHT_SOURCE_ID,
              paint: {
                'line-color': '#81b4d0',
                'line-width': 2,
              },
            },
            'project-grid-labels'
          )
        } else {
          map.addLayer(
            {
              id: HIGHLIGHT_LAYER_ID,
              type: 'circle',
              source: HIGHLIGHT_SOURCE_ID,
              paint: {
                'circle-radius': 5,
                'circle-color': 'rgba(0,0,0,0)',
                'circle-stroke-width': 2,
                'circle-stroke-color': '#81b4d0',
                'circle-stroke-opacity': 1,
              },
            },
            'project-grid-labels'
          )
        }
      })
      .catch(() => removeHighlight())

    return removeHighlight
  }, [hoveredProjectId])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.getStyle() || !mapLoadedRef.current) return
    const effectiveQuery = searchQuery.trim().length >= 2 ? searchQuery.trim() : ''
    const eovCat = selectedEovCategories.length ? selectedEovCategories.join(',') : ''
    const tileKey = `${effectiveQuery}|${eovCat}`
    if (lastAppliedSearchRef.current === tileKey) return
    // Avoid replacing the source on initial load when we have no filters – the style already has project-tiles.
    if (tileKey === '|' && lastAppliedSearchRef.current === undefined) {
      lastAppliedSearchRef.current = tileKey
      return
    }
    lastAppliedSearchRef.current = tileKey

    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    const params = new URLSearchParams()
    if (effectiveQuery) params.set('name', effectiveQuery)
    if (eovCat) params.set('eov_category', eovCat)
    const queryString = params.toString()
    const tileUrl = `${origin}/api/tiles/projects/{z}/{x}/{y}.mvt${queryString ? `?${queryString}` : ''}`

    if (map.getSource('project-tiles')) {
      if (map.getLayer('project-grid-labels')) map.removeLayer('project-grid-labels')
      if (map.getLayer('project-grid')) map.removeLayer('project-grid')
      map.removeSource('project-tiles')
    }
    map.addSource('project-tiles', {
      type: 'vector',
      tiles: [tileUrl],
      minzoom: 0,
      maxzoom: 4,
    })
    const beforeId = map.getLayer(CELL_HOVER_LAYER_ID) ? CELL_HOVER_LAYER_ID : undefined
    map.addLayer(
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
      beforeId
    )
    map.addLayer(
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
      beforeId
    )
  }, [searchQuery, selectedEovCategories, mapReady])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.getStyle()) return

    const removeCellHighlight = () => {
      if (map.getLayer(CELL_HIGHLIGHT_LAYER_ID)) map.removeLayer(CELL_HIGHLIGHT_LAYER_ID)
      if (map.getSource(CELL_HIGHLIGHT_SOURCE_ID)) map.removeSource(CELL_HIGHLIGHT_SOURCE_ID)
    }

    if (!selectedCellBbox || !selectedCellBbox.trim()) {
      removeCellHighlight()
      return
    }

    const parts = selectedCellBbox.split(',').map((p) => parseFloat(p.trim()))
    if (parts.length !== 4 || parts.some(Number.isNaN)) {
      removeCellHighlight()
      return
    }
    const [minLon, minLat, maxLon, maxLat] = parts as [number, number, number, number]
    const polygon: GeoJSON.Feature<GeoJSON.Polygon> = {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [minLon, minLat],
            [maxLon, minLat],
            [maxLon, maxLat],
            [minLon, maxLat],
            [minLon, minLat],
          ],
        ],
      },
      properties: {},
    }
    removeCellHighlight()
    map.addSource(CELL_HIGHLIGHT_SOURCE_ID, {
      type: 'geojson',
      data: polygon,
    })
    map.addLayer(
      {
        id: CELL_HIGHLIGHT_LAYER_ID,
        type: 'fill',
        source: CELL_HIGHLIGHT_SOURCE_ID,
        paint: {
          'fill-color': '#fde047',
          'fill-opacity': 0.35,
          'fill-outline-color': '#ca8a04',
        },
      },
      'project-grid-labels'
    )

    return removeCellHighlight
  }, [selectedCellBbox])

  const toggleEov = (key: string) => {
    if (!onEovCategoriesChange) return
    const next = selectedEovCategories.includes(key)
      ? selectedEovCategories.filter((k) => k !== key)
      : [...selectedEovCategories, key]
    onEovCategoriesChange(next)
  }

  return (
    <div className="map-wrap" style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={containerRef} className="map-container" style={{ width: '100%', height: '100%' }} />
      {onEovCategoriesChange && eovVocabulary?.top_level_eovs?.length ? (
        <div className="map-eov-widget">
          <span className="map-eov-widget-title">EOV filter</span>
          <div className="map-eov-toggles">
            {[...eovVocabulary.top_level_eovs]
              .slice()
              .sort((a, b) => a.label.localeCompare(b.label))
              .map(({ code, label }) => (
              <label key={code} className="map-eov-toggle">
                <input
                  type="checkbox"
                  checked={selectedEovCategories.includes(code)}
                  onChange={() => toggleEov(code)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </div>
      ) : null}
      <div className="map-legend">
        <span className="map-legend-title">Programmes per cell</span>
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
            <span>2</span>
            <span>5</span>
            <span>10</span>
            <span>20+</span>
          </div>
        </div>
      </div>
    </div>
  )
}
