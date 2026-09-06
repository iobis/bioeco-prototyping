import type { ProgrammeStatus } from './programmeStatus'
import {
  EMPTY_READINESS_SELECTION,
  READINESS_DIMENSIONS,
  READINESS_LEVEL_OPTIONS,
  type ReadinessSelection,
} from './readiness'

export type AppView = 'map' | 'readiness' | 'data-quality' | 'about'
export type MapLayerMode = 'programmes' | 'eovs' | 'data'
export type ColorSchemeId = 'hawaii' | 'viridis' | 'inferno' | 'blues'

export interface PortalUrlState {
  view: AppView
  programme: string | null
  bbox: string | null
  q: string
  status: ProgrammeStatus
  eov: string[]
  readiness: ReadinessSelection
  layer: MapLayerMode
  colour: ColorSchemeId
  opacity: number
  labels: boolean
  globe: boolean
}

export const DEFAULT_URL_STATE: PortalUrlState = {
  view: 'map',
  programme: null,
  bbox: null,
  q: '',
  status: 'all',
  eov: [],
  readiness: EMPTY_READINESS_SELECTION,
  layer: 'programmes',
  colour: 'hawaii',
  opacity: 0.4,
  labels: true,
  globe: false,
}

const VIEWS = new Set<AppView>(['map', 'readiness', 'data-quality', 'about'])
const STATUSES = new Set<ProgrammeStatus>(['all', 'active', 'inactive'])
const LAYERS = new Set<MapLayerMode>(['programmes', 'eovs', 'data'])
const COLOURS = new Set<ColorSchemeId>(['hawaii', 'viridis', 'inferno', 'blues'])
const VALID_LEVELS = new Set(READINESS_LEVEL_OPTIONS.map((o) => o.value))

function parseCsv(value: string | null): string[] {
  if (!value?.trim()) return []
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

function parseReadinessLevels(value: string | null): number[] {
  const levels = parseCsv(value)
    .map((part) => Number(part))
    .filter((n) => Number.isInteger(n) && VALID_LEVELS.has(n))
  return [...new Set(levels)].sort((a, b) => a - b)
}

function parseOpacity(value: string | null): number {
  if (value == null || value === '') return DEFAULT_URL_STATE.opacity
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_URL_STATE.opacity
  return Math.min(1, Math.max(0.1, Math.round(n * 20) / 20))
}

function parseBoolFlag(value: string | null, defaultValue: boolean): boolean {
  if (value == null || value === '') return defaultValue
  const v = value.trim().toLowerCase()
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true
  return defaultValue
}

function parseLabels(value: string | null): boolean {
  return parseBoolFlag(value, DEFAULT_URL_STATE.labels)
}

export function parseUrlState(search: string = window.location.search): PortalUrlState {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)

  const viewRaw = params.get('view') as AppView | null
  const statusRaw = params.get('status') as ProgrammeStatus | null
  const layerRaw = (params.get('layer') ?? params.get('metric')) as MapLayerMode | null
  const colourRaw = (params.get('colour') ?? params.get('color')) as ColorSchemeId | null

  const readiness: ReadinessSelection = { ...EMPTY_READINESS_SELECTION }
  for (const { key, param } of READINESS_DIMENSIONS) {
    readiness[key] = parseReadinessLevels(params.get(param))
  }

  return {
    view: viewRaw && VIEWS.has(viewRaw) ? viewRaw : DEFAULT_URL_STATE.view,
    programme: params.get('programme')?.trim() || null,
    bbox: params.get('bbox')?.trim() || null,
    q: params.get('q')?.trim() ?? '',
    status: statusRaw && STATUSES.has(statusRaw) ? statusRaw : DEFAULT_URL_STATE.status,
    eov: parseCsv(params.get('eov')),
    readiness,
    layer: layerRaw && LAYERS.has(layerRaw) ? layerRaw : DEFAULT_URL_STATE.layer,
    colour: colourRaw && COLOURS.has(colourRaw) ? colourRaw : DEFAULT_URL_STATE.colour,
    opacity: parseOpacity(params.get('opacity')),
    labels: parseLabels(params.get('labels')),
    globe: parseBoolFlag(params.get('globe'), DEFAULT_URL_STATE.globe),
  }
}

export function serializeUrlState(state: PortalUrlState): URLSearchParams {
  const params = new URLSearchParams()
  const d = DEFAULT_URL_STATE

  if (state.view !== d.view) params.set('view', state.view)
  if (state.programme) params.set('programme', state.programme)
  if (state.bbox) params.set('bbox', state.bbox)
  if (state.q.trim()) params.set('q', state.q.trim())
  if (state.status !== d.status) params.set('status', state.status)
  if (state.eov.length) params.set('eov', state.eov.join(','))
  for (const { key, param } of READINESS_DIMENSIONS) {
    const levels = state.readiness[key]
    if (levels.length) params.set(param, [...levels].sort((a, b) => a - b).join(','))
  }
  if (state.layer !== d.layer) params.set('layer', state.layer)
  if (state.colour !== d.colour) params.set('colour', state.colour)
  if (state.opacity !== d.opacity) params.set('opacity', String(state.opacity))
  if (state.labels !== d.labels) params.set('labels', state.labels ? '1' : '0')
  if (state.globe !== d.globe) params.set('globe', state.globe ? '1' : '0')

  return params
}

export function replaceUrlState(state: PortalUrlState): void {
  const qs = serializeUrlState(state).toString()
  const next = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (next !== current) {
    window.history.replaceState(null, '', next)
  }
}
