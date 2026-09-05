import maplibregl, { type StyleSpecification } from 'maplibre-gl'
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import type { EovVocabulary } from '../eovVocabulary'
import type { ProgrammeStatus } from '../programmeStatus'
import { PROGRAMME_STATUS_OPTIONS } from '../programmeStatus'
import {
  EMPTY_READINESS_SELECTION,
  READINESS_DIMENSIONS,
  READINESS_LEVEL_OPTIONS,
  appendReadinessParams,
  readinessSelectionKey,
  selectReadinessLevelRange,
  toggleReadinessLevel,
  type ReadinessDimension,
  type ReadinessSelection,
} from '../readiness'

const HIGHLIGHT_SOURCE_ID = 'project-highlight'
const HIGHLIGHT_LAYER_ID = 'project-highlight-layer'
const CELL_HIGHLIGHT_SOURCE_ID = 'cell-highlight'
const CELL_HIGHLIGHT_LAYER_ID = 'cell-highlight-layer'
const CELL_HOVER_SOURCE_ID = 'cell-hover'
const CELL_HOVER_LAYER_ID = 'cell-hover-layer'
const PROJECT_GRID_LAYER_ID = 'project-grid'

/** Highest zoom with OBIS land/coastline vector tiles (https://tiles.obis.org). */
const BASEMAP_MAX_ZOOM = 12

/** Map land/ocean fill; grid cells are drawn over this at GRID_FILL_OPACITY. */
const MAP_SURFACE = '#f8fafc'
const GRID_FILL_OPACITY = 0.4

/** Scientific Colour Maps Hawaii (sampled) for grid choropleths. */
const GRID_COLORS = ['#8c0862', '#c2456e', '#e08a5b', '#c9c35a', '#6db37a', '#2a6b7a'] as const

type GridMetric = 'programmes' | 'eovs'

const GRID_METRICS: Record<
  GridMetric,
  {
    label: string
    property: string
    stops: readonly number[]
    legendLabels: readonly string[]
  }
> = {
  programmes: {
    label: 'Programmes per cell',
    property: 'unique_projects.value',
    stops: [0, 1, 2, 5, 10, 20],
    legendLabels: ['0', '1', '2', '5', '10', '20+'],
  },
  eovs: {
    label: 'EOVs per cell',
    property: 'unique_eovs.value',
    stops: [0, 1, 2, 3, 5, 8],
    legendLabels: ['0', '1', '2', '3', '5', '8+'],
  },
}

const GRID_METRIC_OPTIONS: { value: GridMetric; label: string }[] = [
  { value: 'programmes', label: 'Programmes' },
  { value: 'eovs', label: 'EOVs' },
]

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/** Blend a fill color over the map surface at the same opacity as grid cells. */
function legendSwatchColor(hex: string): string {
  const [r, g, b] = parseHex(hex)
  const [br, bg, bb] = parseHex(MAP_SURFACE)
  const a = GRID_FILL_OPACITY
  const mix = (c: number, base: number) => Math.round(c * a + base * (1 - a))
  return `rgb(${mix(r, br)}, ${mix(g, bg)}, ${mix(b, bb)})`
}

const GRID_LEGEND_COLORS = GRID_COLORS.map(legendSwatchColor)

function gridFillColor(metric: GridMetric): maplibregl.ExpressionSpecification {
  const { property, stops } = GRID_METRICS[metric]
  const stopsExpr: (string | number)[] = []
  for (let i = 0; i < stops.length; i++) {
    stopsExpr.push(stops[i], GRID_COLORS[i])
  }
  return [
    'interpolate',
    ['linear'],
    ['get', property],
    ...stopsExpr,
  ] as maplibregl.ExpressionSpecification
}

function gridLabelField(metric: GridMetric): maplibregl.ExpressionSpecification {
  return ['coalesce', ['to-string', ['get', GRID_METRICS[metric].property]], '0']
}

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
  selectedEovCategories?: string[]
  onEovCategoriesChange?: (keys: string[]) => void
  eovVocabulary?: EovVocabulary | null
  programmeStatus?: ProgrammeStatus
  onProgrammeStatusChange?: (status: ProgrammeStatus) => void
  selectedReadiness?: ReadinessSelection
  onReadinessChange?: (selection: ReadinessSelection) => void
}

export function Map({
  hoveredProjectId = null,
  selectedCellBbox = null,
  onCellClick,
  selectedEovCategories = [],
  onEovCategoriesChange,
  eovVocabulary = null,
  programmeStatus = 'all',
  onProgrammeStatusChange,
  selectedReadiness = EMPTY_READINESS_SELECTION,
  onReadinessChange,
}: MapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const mapLoadedRef = useRef(false)
  const [mapReady, setMapReady] = useState(false)
  const [gridMetric, setGridMetric] = useState<GridMetric>('programmes')
  const gridMetricRef = useRef<GridMetric>('programmes')
  gridMetricRef.current = gridMetric
  const lastAppliedSearchRef = useRef<string | undefined>(undefined)
  const readinessAnchorRef = useRef<Partial<Record<ReadinessDimension, number>>>({})
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
          maxzoom: BASEMAP_MAX_ZOOM,
        },
        coastlines: {
          type: 'vector',
          tiles: ['https://tiles.obis.org/coastlines_tiles/{z}/{x}/{y}.pbf'],
          minzoom: 0,
          maxzoom: BASEMAP_MAX_ZOOM,
        },
      },
      layers: [
        {
          id: 'background',
          type: 'background',
          paint: { 'background-color': MAP_SURFACE },
        },
        {
          id: 'land_polygons',
          type: 'fill',
          source: 'land_polygons',
          'source-layer': 'land',
          paint: {
            'fill-color': MAP_SURFACE,
            'fill-opacity': 1,
          },
        },
        {
          id: 'project-grid',
          type: 'fill',
          source: 'project-tiles',
          'source-layer': 'aggs',
          paint: {
            'fill-color': gridFillColor('programmes'),
            'fill-opacity': GRID_FILL_OPACITY,
            'fill-outline-color': 'rgba(255,255,255,0.35)',
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
          id: 'project-grid-labels',
          type: 'symbol',
          source: 'project-tiles',
          'source-layer': 'aggs',
          layout: {
            'text-field': gridLabelField('programmes'),
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
      maxZoom: BASEMAP_MAX_ZOOM,
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
    fetch(`/api/projects/${hoveredProjectId}?include_geometry=true`)
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
    const eovCat = selectedEovCategories.length ? selectedEovCategories.join(',') : ''
    const statusKey = programmeStatus === 'all' ? '' : programmeStatus
    const readinessKey = readinessSelectionKey(selectedReadiness)
    const tileKey = `${eovCat}|${statusKey}|${readinessKey}`
    if (lastAppliedSearchRef.current === tileKey) return
    // Avoid replacing the source on initial load when we have no filters – the style already has project-tiles.
    if (!eovCat && !statusKey && !readinessKey && lastAppliedSearchRef.current === undefined) {
      lastAppliedSearchRef.current = tileKey
      return
    }
    lastAppliedSearchRef.current = tileKey

    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    const params = new URLSearchParams()
    if (eovCat) params.set('eov_category', eovCat)
    if (statusKey) params.set('status', statusKey)
    appendReadinessParams(params, selectedReadiness)
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
    const beforeId = map.getLayer('coastlines')
      ? 'coastlines'
      : map.getLayer(CELL_HOVER_LAYER_ID)
        ? CELL_HOVER_LAYER_ID
        : undefined
    map.addLayer(
      {
        id: 'project-grid',
        type: 'fill',
        source: 'project-tiles',
        'source-layer': 'aggs',
        paint: {
          'fill-color': gridFillColor(gridMetricRef.current),
          'fill-opacity': GRID_FILL_OPACITY,
          'fill-outline-color': 'rgba(255,255,255,0.35)',
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
          'text-field': gridLabelField(gridMetricRef.current),
          'text-size': 7,
          'text-anchor': 'center',
          'symbol-placement': 'point',
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': '#0f172a',
        },
      },
      map.getLayer(CELL_HOVER_LAYER_ID) ? CELL_HOVER_LAYER_ID : undefined
    )
  }, [selectedEovCategories, programmeStatus, selectedReadiness, mapReady])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    if (map.getLayer(PROJECT_GRID_LAYER_ID)) {
      map.setPaintProperty(PROJECT_GRID_LAYER_ID, 'fill-color', gridFillColor(gridMetric))
    }
    if (map.getLayer('project-grid-labels')) {
      map.setLayoutProperty('project-grid-labels', 'text-field', gridLabelField(gridMetric))
    }
  }, [gridMetric, mapReady])

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

  const onToggleReadiness = (
    dimension: ReadinessDimension,
    level: number,
    event: MouseEvent
  ) => {
    if (!onReadinessChange) return
    if (event.shiftKey) {
      const anchor = readinessAnchorRef.current[dimension] ?? level
      onReadinessChange(selectReadinessLevelRange(selectedReadiness, dimension, anchor, level))
    } else {
      onReadinessChange(toggleReadinessLevel(selectedReadiness, dimension, level))
      readinessAnchorRef.current[dimension] = level
    }
  }

  return (
    <div className="map-wrap" style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={containerRef} className="map-container" style={{ width: '100%', height: '100%' }} />
      <div className="map-eov-widget">
        <div className="map-filter-section">
          <span className="map-eov-widget-title">Map layer</span>
          <div className="status-filter" role="group" aria-label="Grid metric">
            {GRID_METRIC_OPTIONS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                className={`status-filter-btn${gridMetric === value ? ' is-active' : ''}`}
                aria-pressed={gridMetric === value}
                onClick={() => setGridMetric(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {onEovCategoriesChange && eovVocabulary?.top_level_eovs?.length ? (
          <div className="map-filter-section">
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
        {onReadinessChange ? (
          READINESS_DIMENSIONS.map(({ key, label }) => (
            <div key={key} className="map-filter-section">
              <span className="map-eov-widget-title">{label}</span>
              <div className="status-filter readiness-level-filter" role="group" aria-label={label}>
                {READINESS_LEVEL_OPTIONS.map(({ value, shortLabel, label: fullLabel }) => (
                  <button
                    key={value}
                    type="button"
                    className={`status-filter-btn${selectedReadiness[key].includes(value) ? ' is-active' : ''}`}
                    aria-pressed={selectedReadiness[key].includes(value)}
                    title={fullLabel}
                    onClick={(e) => onToggleReadiness(key, value, e)}
                  >
                    {shortLabel}
                  </button>
                ))}
              </div>
            </div>
          ))
        ) : null}
        {onProgrammeStatusChange && (
          <div className="map-filter-section">
            <span className="map-eov-widget-title">Status</span>
            <div className="status-filter" role="group" aria-label="Programme status">
              {PROGRAMME_STATUS_OPTIONS.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  className={`status-filter-btn${programmeStatus === value ? ' is-active' : ''}`}
                  aria-pressed={programmeStatus === value}
                  onClick={() => onProgrammeStatusChange(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="map-legend">
        <span className="map-legend-title">{GRID_METRICS[gridMetric].label}</span>
        <div className="map-legend-scale">
          <div className="map-legend-bar">
            {GRID_LEGEND_COLORS.map((color) => (
              <span key={color} style={{ background: color }} />
            ))}
          </div>
          <div className="map-legend-labels">
            {GRID_METRICS[gridMetric].legendLabels.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
