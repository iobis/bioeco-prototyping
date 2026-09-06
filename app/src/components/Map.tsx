import maplibregl, { type StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import type { EovVocabulary } from '../eovVocabulary'
import type { ProgrammeStatus } from '../programmeStatus'
import { PROGRAMME_STATUS_OPTIONS } from '../programmeStatus'
import type { ColorSchemeId, MapLayerMode } from '../urlState'
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
const OBIS_SOURCE_ID = 'obis-occurrence'
const OBIS_LAYER_ID = 'obis-occurrence-fill'
const OBIS_LABELS_LAYER_ID = 'obis-occurrence-labels'
/** OBIS occurrence density tiles; filter with `tags=` (comma-separated GOOS EOV URLs). */
const OBIS_TILE_TEMPLATE = 'https://api.obis.org/occurrence/tile/{x}/{y}/{z}.mvt'

/** Highest zoom with OBIS land/coastline vector tiles (https://tiles.obis.org). */
const BASEMAP_MAX_ZOOM = 12

/** Map land/ocean fill; grid cells are drawn over this. */
const MAP_SURFACE = '#f8fafc'
const DEFAULT_GRID_OPACITY = 0.4

/** Six-stop sequential ramps for grid choropleths (low → high). */
const COLOR_SCHEMES: Record<
  ColorSchemeId,
  { label: string; colors: readonly [string, string, string, string, string, string] }
> = {
  hawaii: {
    label: 'Hawaii',
    colors: ['#8c0862', '#c2456e', '#e08a5b', '#c9c35a', '#6db37a', '#2a6b7a'],
  },
  viridis: {
    label: 'Viridis',
    colors: ['#440154', '#414487', '#2a788e', '#22a884', '#7ad151', '#fde725'],
  },
  inferno: {
    label: 'Inferno',
    colors: ['#000004', '#420a68', '#932667', '#dd513a', '#fca50a', '#fcffa4'],
  },
  blues: {
    label: 'Blues',
    colors: ['#eff3ff', '#c6dbef', '#9ecae1', '#6baed6', '#3182bd', '#08519c'],
  },
}

const COLOR_SCHEME_OPTIONS = (Object.keys(COLOR_SCHEMES) as ColorSchemeId[]).map((id) => ({
  id,
  label: COLOR_SCHEMES[id].label,
}))

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

/** OBIS occurrence count legend (matches mapper.obis.org / explore map). */
const OBIS_METRIC = {
  label: 'OBIS records',
  property: 'doc_count',
  stops: [1, 10, 100, 1000, 10000, 50000] as const,
  legendLabels: ['1', '10', '100', '1k', '10k', '50k+'] as const,
}

const MAP_LAYER_OPTIONS: { value: MapLayerMode; label: string }[] = [
  { value: 'programmes', label: 'Programmes' },
  { value: 'eovs', label: 'EOVs' },
  { value: 'data', label: 'Data' },
]

function eovTagUrls(vocab: EovVocabulary | null, codes: string[]): string[] {
  if (!vocab?.top_level_eovs?.length || !codes.length) return []
  const byCode = Object.fromEntries(vocab.top_level_eovs.map((e) => [e.code, e]))
  const urls: string[] = []
  for (const code of codes) {
    const url = byCode[code]?.url?.trim()
    if (url) urls.push(url)
  }
  return urls
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/** Blend a fill color over the map surface at the given opacity. */
function legendSwatchColor(hex: string, opacity: number): string {
  const [r, g, b] = parseHex(hex)
  const [br, bg, bb] = parseHex(MAP_SURFACE)
  const a = opacity
  const mix = (c: number, base: number) => Math.round(c * a + base * (1 - a))
  return `rgb(${mix(r, br)}, ${mix(g, bg)}, ${mix(b, bb)})`
}

function gridFillColor(
  metric: GridMetric,
  colors: readonly string[],
): maplibregl.ExpressionSpecification {
  const { property, stops } = GRID_METRICS[metric]
  const stopsExpr: (string | number)[] = []
  for (let i = 0; i < stops.length; i++) {
    stopsExpr.push(stops[i], colors[i])
  }
  return [
    'interpolate',
    ['linear'],
    ['get', property],
    ...stopsExpr,
  ] as maplibregl.ExpressionSpecification
}

function obisFillColor(colors: readonly string[]): maplibregl.ExpressionSpecification {
  const stopsExpr: (string | number)[] = []
  for (let i = 0; i < OBIS_METRIC.stops.length; i++) {
    stopsExpr.push(OBIS_METRIC.stops[i], colors[i])
  }
  return [
    'interpolate',
    ['linear'],
    ['get', OBIS_METRIC.property],
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
  mapLayer?: MapLayerMode
  onMapLayerChange?: (layer: MapLayerMode) => void
  colorScheme?: ColorSchemeId
  onColorSchemeChange?: (scheme: ColorSchemeId) => void
  gridOpacity?: number
  onGridOpacityChange?: (opacity: number) => void
  showGridLabels?: boolean
  onShowGridLabelsChange?: (show: boolean) => void
  globe?: boolean
  onGlobeChange?: (globe: boolean) => void
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
  mapLayer = 'programmes',
  onMapLayerChange,
  colorScheme = 'hawaii',
  onColorSchemeChange,
  gridOpacity = DEFAULT_GRID_OPACITY,
  onGridOpacityChange,
  showGridLabels = true,
  onShowGridLabelsChange,
  globe = false,
  onGlobeChange,
}: MapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const mapLoadedRef = useRef(false)
  const [mapReady, setMapReady] = useState(false)
  const mapLayerRef = useRef<MapLayerMode>(mapLayer)
  const colorSchemeRef = useRef<ColorSchemeId>(colorScheme)
  const gridOpacityRef = useRef(gridOpacity)
  const showGridLabelsRef = useRef(showGridLabels)
  mapLayerRef.current = mapLayer
  colorSchemeRef.current = colorScheme
  gridOpacityRef.current = gridOpacity
  showGridLabelsRef.current = showGridLabels
  const lastAppliedSearchRef = useRef<string | undefined>(undefined)
  const readinessAnchorRef = useRef<Partial<Record<ReadinessDimension, number>>>({})
  const hoveredIdRef = useRef<string | null>(null)
  const selectedCellBboxRef = useRef<string | null>(null)
  const onGlobeChangeRef = useRef(onGlobeChange)
  const globeRef = useRef(globe)
  onGlobeChangeRef.current = onGlobeChange
  globeRef.current = globe
  hoveredIdRef.current = hoveredProjectId ?? null
  selectedCellBboxRef.current = selectedCellBbox ?? null
  const isDataLayer = mapLayer === 'data'
  const gridMetric: GridMetric = mapLayer === 'eovs' ? 'eovs' : 'programmes'

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
            'fill-color': gridFillColor('programmes', COLOR_SCHEMES.hawaii.colors),
            'fill-opacity': DEFAULT_GRID_OPACITY,
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
            visibility: 'visible',
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

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left')
    map.addControl(new maplibregl.GlobeControl(), 'top-left')

    // Sync URL from the control button only — projectiontransition also fires during
    // programmatic restore and was flipping globe back to mercator.
    const bindGlobeControl = () => {
      const btn = map
        .getContainer()
        .querySelector<HTMLButtonElement>(
          'button.maplibregl-ctrl-globe, button.maplibregl-ctrl-globe-enabled',
        )
      if (!btn || btn.dataset.globeBound === '1') return
      btn.dataset.globeBound = '1'
      btn.addEventListener('click', () => {
        window.setTimeout(() => {
          onGlobeChangeRef.current?.(map.getProjection()?.type === 'globe')
        }, 0)
      })
    }
    bindGlobeControl()

    const applyProjection = (wantGlobe: boolean) => {
      const isGlobe = map.getProjection()?.type === 'globe'
      if (wantGlobe === isGlobe) return
      map.setProjection({ type: wantGlobe ? 'globe' : 'mercator' })
    }

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
    // setProjection requires a loaded style; restore URL globe here (not only on React effect).
    map.once('style.load', () => {
      if (globeRef.current) applyProjection(true)
    })
    if (map.isStyleLoaded()) {
      onLoad()
      if (globeRef.current) applyProjection(true)
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
          'fill-color': gridFillColor(
            mapLayerRef.current === 'eovs' ? 'eovs' : 'programmes',
            COLOR_SCHEMES[colorSchemeRef.current].colors,
          ),
          'fill-opacity': gridOpacityRef.current,
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
          'text-field': gridLabelField(mapLayerRef.current === 'eovs' ? 'eovs' : 'programmes'),
          'text-size': 7,
          'text-anchor': 'center',
          'symbol-placement': 'point',
          'text-allow-overlap': false,
          visibility: showGridLabelsRef.current ? 'visible' : 'none',
        },
        paint: {
          'text-color': '#0f172a',
        },
      },
      map.getLayer(CELL_HOVER_LAYER_ID) ? CELL_HOVER_LAYER_ID : undefined
    )
    if (mapLayerRef.current === 'data') {
      if (map.getLayer(PROJECT_GRID_LAYER_ID)) {
        map.setLayoutProperty(PROJECT_GRID_LAYER_ID, 'visibility', 'none')
      }
      if (map.getLayer('project-grid-labels')) {
        map.setLayoutProperty('project-grid-labels', 'visibility', 'none')
      }
    }
  }, [selectedEovCategories, programmeStatus, selectedReadiness, mapReady])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return

    const removeObis = () => {
      if (map.getLayer(OBIS_LABELS_LAYER_ID)) map.removeLayer(OBIS_LABELS_LAYER_ID)
      if (map.getLayer(OBIS_LAYER_ID)) map.removeLayer(OBIS_LAYER_ID)
      if (map.getSource(OBIS_SOURCE_ID)) map.removeSource(OBIS_SOURCE_ID)
    }

    const setProgrammeGridVisible = (visible: boolean) => {
      const visibility = visible ? 'visible' : 'none'
      if (map.getLayer(PROJECT_GRID_LAYER_ID)) {
        map.setLayoutProperty(PROJECT_GRID_LAYER_ID, 'visibility', visibility)
      }
      if (map.getLayer('project-grid-labels')) {
        map.setLayoutProperty(
          'project-grid-labels',
          'visibility',
          visible && showGridLabelsRef.current ? 'visible' : 'none',
        )
      }
      if (map.getLayer(CELL_HOVER_LAYER_ID)) {
        map.setLayoutProperty(CELL_HOVER_LAYER_ID, 'visibility', visibility)
      }
      if (map.getLayer(CELL_HIGHLIGHT_LAYER_ID)) {
        map.setLayoutProperty(CELL_HIGHLIGHT_LAYER_ID, 'visibility', visibility)
      }
    }

    if (mapLayer !== 'data') {
      removeObis()
      setProgrammeGridVisible(true)
      return
    }

    setProgrammeGridVisible(false)

    const tags = eovTagUrls(eovVocabulary, selectedEovCategories)
    if (!tags.length) {
      removeObis()
      return
    }

    const params = new URLSearchParams()
    params.set('tags', tags.join(','))
    const tileUrl = `${OBIS_TILE_TEMPLATE}?${params.toString()}`

    removeObis()
    map.addSource(OBIS_SOURCE_ID, {
      type: 'vector',
      tiles: [tileUrl],
    })
    const beforeId = map.getLayer('coastlines')
      ? 'coastlines'
      : map.getLayer(CELL_HOVER_LAYER_ID)
        ? CELL_HOVER_LAYER_ID
        : undefined
    map.addLayer(
      {
        id: OBIS_LAYER_ID,
        type: 'fill',
        source: OBIS_SOURCE_ID,
        'source-layer': 'grid',
        paint: {
          'fill-color': obisFillColor(COLOR_SCHEMES[colorSchemeRef.current].colors),
          'fill-opacity': gridOpacityRef.current,
          'fill-outline-color': 'rgba(255,255,255,0.35)',
        },
      },
      beforeId,
    )
    map.addLayer(
      {
        id: OBIS_LABELS_LAYER_ID,
        type: 'symbol',
        source: OBIS_SOURCE_ID,
        'source-layer': 'grid',
        layout: {
          'text-field': ['coalesce', ['to-string', ['get', OBIS_METRIC.property]], ''],
          'text-size': 7,
          'text-anchor': 'center',
          'symbol-placement': 'point',
          'text-allow-overlap': false,
          visibility: showGridLabelsRef.current ? 'visible' : 'none',
        },
        paint: {
          'text-color': '#0f172a',
          'text-halo-color': 'rgba(255,255,255,0.9)',
          'text-halo-width': 1,
        },
      },
      map.getLayer(CELL_HOVER_LAYER_ID) ? CELL_HOVER_LAYER_ID : undefined,
    )
  }, [mapLayer, selectedEovCategories, eovVocabulary, mapReady])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    if (mapLayer === 'data') {
      if (map.getLayer(OBIS_LAYER_ID)) {
        map.setPaintProperty(OBIS_LAYER_ID, 'fill-color', obisFillColor(COLOR_SCHEMES[colorScheme].colors))
        map.setPaintProperty(OBIS_LAYER_ID, 'fill-opacity', gridOpacity)
      }
      if (map.getLayer(OBIS_LABELS_LAYER_ID)) {
        map.setLayoutProperty(
          OBIS_LABELS_LAYER_ID,
          'visibility',
          showGridLabels ? 'visible' : 'none',
        )
      }
      return
    }
    if (map.getLayer(PROJECT_GRID_LAYER_ID)) {
      map.setPaintProperty(
        PROJECT_GRID_LAYER_ID,
        'fill-color',
        gridFillColor(gridMetric, COLOR_SCHEMES[colorScheme].colors),
      )
      map.setPaintProperty(PROJECT_GRID_LAYER_ID, 'fill-opacity', gridOpacity)
    }
    if (map.getLayer('project-grid-labels')) {
      map.setLayoutProperty('project-grid-labels', 'text-field', gridLabelField(gridMetric))
      map.setLayoutProperty(
        'project-grid-labels',
        'visibility',
        showGridLabels ? 'visible' : 'none',
      )
    }
  }, [mapLayer, gridMetric, colorScheme, gridOpacity, showGridLabels, mapReady])

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

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const isGlobe = map.getProjection()?.type === 'globe'
    if (globe === isGlobe) return
    map.setProjection({ type: globe ? 'globe' : 'mercator' })
  }, [globe, mapReady])

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
          <div className="status-filter" role="group" aria-label="Map layer">
            {MAP_LAYER_OPTIONS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                className={`status-filter-btn${mapLayer === value ? ' is-active' : ''}`}
                aria-pressed={mapLayer === value}
                onClick={() => onMapLayerChange?.(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {onEovCategoriesChange && eovVocabulary?.top_level_eovs?.length ? (
          <div className="map-filter-section">
            <span className="map-eov-widget-title">
              {isDataLayer ? 'EOV (OBIS tags)' : 'EOV filter'}
            </span>
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
            {isDataLayer && !selectedEovCategories.length ? (
              <p className="map-data-hint">Select an EOV to show tagged OBIS occurrences.</p>
            ) : null}
          </div>
        ) : null}
        {!isDataLayer && onReadinessChange ? (
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
        {!isDataLayer && onProgrammeStatusChange && (
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
        <div className="map-filter-section">
          <span className="map-eov-widget-title">Colour</span>
          <select
            className="map-style-select"
            value={colorScheme}
            aria-label="Grid colour scheme"
            onChange={(e) => onColorSchemeChange?.(e.target.value as ColorSchemeId)}
          >
            {COLOR_SCHEME_OPTIONS.map(({ id, label }) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="map-filter-section">
          <span className="map-eov-widget-title">
            Opacity <span className="map-opacity-value">{Math.round(gridOpacity * 100)}%</span>
          </span>
          <input
            type="range"
            className="map-opacity-slider"
            min={0.1}
            max={1}
            step={0.05}
            value={gridOpacity}
            aria-label="Grid layer opacity"
            style={
              {
                '--slider-progress': `${((gridOpacity - 0.1) / 0.9) * 100}%`,
              } as CSSProperties
            }
            onChange={(e) => onGridOpacityChange?.(Number(e.target.value))}
          />
        </div>
        <div className="map-filter-section">
          <label className="map-eov-toggle">
            <input
              type="checkbox"
              checked={showGridLabels}
              onChange={(e) => onShowGridLabelsChange?.(e.target.checked)}
            />
            <span>{isDataLayer ? 'Show record counts' : 'Show cell counts'}</span>
          </label>
        </div>
      </div>
      <div className="map-legend">
        <span className="map-legend-title">
          {isDataLayer ? OBIS_METRIC.label : GRID_METRICS[gridMetric].label}
        </span>
        <div className="map-legend-scale">
          <div className="map-legend-bar">
            {COLOR_SCHEMES[colorScheme].colors.map((color) => (
              <span key={color} style={{ background: legendSwatchColor(color, gridOpacity) }} />
            ))}
          </div>
          <div className="map-legend-labels">
            {(isDataLayer ? OBIS_METRIC.legendLabels : GRID_METRICS[gridMetric].legendLabels).map(
              (label) => (
                <span key={label}>{label}</span>
              ),
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
