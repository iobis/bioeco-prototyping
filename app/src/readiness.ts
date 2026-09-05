/** GOOS Framework for Ocean Observing readiness levels (1–9). */
export const READINESS_LEVEL_OPTIONS: Array<{ value: number; shortLabel: string; label: string }> = [
  { value: 1, shortLabel: 'L1', label: 'L1 Idea' },
  { value: 2, shortLabel: 'L2', label: 'L2 Plan' },
  { value: 3, shortLabel: 'L3', label: 'L3 Proof of concept' },
  { value: 4, shortLabel: 'L4', label: 'L4 Trial' },
  { value: 5, shortLabel: 'L5', label: 'L5 Verification' },
  { value: 6, shortLabel: 'L6', label: 'L6 Operational' },
  { value: 7, shortLabel: 'L7', label: 'L7 Fitness for purpose' },
  { value: 8, shortLabel: 'L8', label: 'L8 Mission qualified' },
  { value: 9, shortLabel: 'L9', label: 'L9 Sustained' },
]

export type ReadinessDimension = 'data' | 'requirements' | 'coordination'

export type ReadinessSelection = Record<ReadinessDimension, number[]>

export const EMPTY_READINESS_SELECTION: ReadinessSelection = {
  data: [],
  requirements: [],
  coordination: [],
}

export const READINESS_DIMENSIONS: Array<{ key: ReadinessDimension; label: string; param: string }> = [
  { key: 'data', label: 'Readiness – Data', param: 'readiness_data' },
  { key: 'requirements', label: 'Readiness – Requirements', param: 'readiness_requirements' },
  { key: 'coordination', label: 'Readiness – Coordination', param: 'readiness_coordination' },
]

export function readinessSelectionKey(selection: ReadinessSelection): string {
  return READINESS_DIMENSIONS.map(({ key }) => {
    const levels = selection[key]
    return levels.length ? [...levels].sort((a, b) => a - b).join(',') : ''
  }).join('|')
}

export function appendReadinessParams(params: URLSearchParams, selection: ReadinessSelection): void {
  for (const { key, param } of READINESS_DIMENSIONS) {
    const levels = selection[key]
    if (levels.length) {
      params.set(param, [...levels].sort((a, b) => a - b).join(','))
    }
  }
}

export function toggleReadinessLevel(
  selection: ReadinessSelection,
  dimension: ReadinessDimension,
  level: number
): ReadinessSelection {
  const current = selection[dimension]
  const nextLevels = current.includes(level)
    ? current.filter((n) => n !== level)
    : [...current, level]
  return { ...selection, [dimension]: nextLevels }
}

/** Select every level from ``fromLevel`` through ``toLevel`` (inclusive) for a dimension. */
export function selectReadinessLevelRange(
  selection: ReadinessSelection,
  dimension: ReadinessDimension,
  fromLevel: number,
  toLevel: number
): ReadinessSelection {
  const lo = Math.min(fromLevel, toLevel)
  const hi = Math.max(fromLevel, toLevel)
  const range = READINESS_LEVEL_OPTIONS.map((o) => o.value).filter((n) => n >= lo && n <= hi)
  const merged = new Set([...selection[dimension], ...range])
  return { ...selection, [dimension]: [...merged].sort((a, b) => a - b) }
}
