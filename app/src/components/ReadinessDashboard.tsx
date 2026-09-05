import { useEffect, useMemo, useState } from 'react'
import type { EovVocabulary } from '../eovVocabulary'
import { READINESS_LEVEL_OPTIONS } from '../readiness'

type LevelCounts = Record<string, number>

interface EovReadinessRow {
  code: string
  programmes: number
  data: LevelCounts
  requirements: LevelCounts
  coordination: LevelCounts
}

interface ReadinessByEovResponse {
  programmes_with_readiness: number
  eovs: EovReadinessRow[]
}

interface ReadinessDashboardProps {
  eovVocabulary?: EovVocabulary | null
}

const DIMENSIONS: Array<{ key: keyof Pick<EovReadinessRow, 'data' | 'requirements' | 'coordination'>; label: string }> = [
  { key: 'data', label: 'Data' },
  { key: 'requirements', label: 'Requirements' },
  { key: 'coordination', label: 'Coordination' },
]

/** Hawaii Scientific Colour Maps (same family as the grid choropleth): L1 → L9. */
const LEVEL_COLORS: Record<number, string> = {
  1: '#8c0862',
  2: '#ae2e6a',
  3: '#ca5669',
  4: '#dc815d',
  5: '#d4a65a',
  6: '#bec15e',
  7: '#84b772',
  8: '#54987a',
  9: '#2a6b7a',
}

function sumCounts(counts: LevelCounts): number {
  return Object.values(counts).reduce((a, b) => a + b, 0)
}

function weightedMean(counts: LevelCounts): number | null {
  let sum = 0
  let n = 0
  for (let level = 1; level <= 9; level++) {
    const c = counts[String(level)] || 0
    sum += level * c
    n += c
  }
  return n ? sum / n : null
}

function StackedBar({ counts, label }: { counts: LevelCounts; label: string }) {
  const total = sumCounts(counts)
  if (!total) {
    return (
      <div className="rd-bar-row">
        <span className="rd-bar-label">{label}</span>
        <div className="rd-bar rd-bar--empty" aria-label={`${label}: no data`}>
          <span className="rd-bar-empty-text">No data</span>
        </div>
      </div>
    )
  }
  return (
    <div className="rd-bar-row">
      <span className="rd-bar-label">{label}</span>
      <div
        className="rd-bar"
        role="img"
        aria-label={`${label}: ${total} programmes across levels`}
      >
        {READINESS_LEVEL_OPTIONS.map(({ value, label: levelLabel }) => {
          const count = counts[String(value)] || 0
          if (!count) return null
          const pct = (count / total) * 100
          return (
            <span
              key={value}
              className="rd-bar-seg"
              style={{ width: `${pct}%`, background: LEVEL_COLORS[value] }}
              title={`${levelLabel}: ${count}`}
            />
          )
        })}
      </div>
      <span className="rd-bar-mean" title="Mean level">
        {weightedMean(counts)?.toFixed(1) ?? '—'}
      </span>
    </div>
  )
}

export function ReadinessDashboard({ eovVocabulary = null }: ReadinessDashboardProps) {
  const [data, setData] = useState<ReadinessByEovResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    fetch('/api/stats/readiness-by-eov')
      .then((r) => {
        if (!r.ok) throw new Error(r.statusText)
        return r.json()
      })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const rows = useMemo(() => {
    const byCode = new Map((data?.eovs ?? []).map((e) => [e.code, e]))
    const vocab = eovVocabulary?.top_level_eovs ?? []
    if (vocab.length) {
      return [...vocab]
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((t) => {
          const stats = byCode.get(t.code)
          return {
            code: t.code,
            label: t.label,
            badge: t.badge?.bg ?? '#94a3b8',
            programmes: stats?.programmes ?? 0,
            data: stats?.data ?? {},
            requirements: stats?.requirements ?? {},
            coordination: stats?.coordination ?? {},
          }
        })
    }
    return (data?.eovs ?? []).map((e) => ({
      code: e.code,
      label: e.code,
      badge: '#94a3b8',
      programmes: e.programmes,
      data: e.data,
      requirements: e.requirements,
      coordination: e.coordination,
    }))
  }, [data, eovVocabulary])

  return (
    <div className="rd-page">
      <header className="rd-header">
        <div>
          <h2 className="rd-title">Readiness by EOV</h2>
          <p className="rd-subtitle">
            Distribution of GOOS readiness levels across programmes that report each Essential Ocean Variable.
            Mean level is shown to the right of each bar.
          </p>
        </div>
        {data && (
          <p className="rd-meta">
            Based on <strong>{data.programmes_with_readiness}</strong> programmes with readiness metadata
          </p>
        )}
      </header>

      <div className="rd-legend" aria-label="Level colour legend">
        {READINESS_LEVEL_OPTIONS.map(({ value, shortLabel, label }) => (
          <span key={value} className="rd-legend-item" title={label}>
            <span className="rd-legend-swatch" style={{ background: LEVEL_COLORS[value] }} />
            {shortLabel}
          </span>
        ))}
      </div>

      {loading && <p className="list-message">Loading readiness stats…</p>}
      {error && <p className="list-message list-error">Error: {error}</p>}

      {!loading && !error && (
        <div className="rd-list">
          {rows.map((row) => (
            <article key={row.code} className="rd-eov">
              <div className="rd-eov-head">
                <span className="rd-eov-dot" style={{ background: row.badge }} aria-hidden />
                <h3 className="rd-eov-name">{row.label}</h3>
                <span className="rd-eov-count">
                  {row.programmes
                    ? `${row.programmes} programme${row.programmes === 1 ? '' : 's'}`
                    : 'No readiness data'}
                </span>
              </div>
              {row.programmes > 0 ? (
                <div className="rd-eov-bars">
                  {DIMENSIONS.map(({ key, label }) => (
                    <StackedBar key={key} label={label} counts={row[key] as LevelCounts} />
                  ))}
                </div>
              ) : (
                <p className="rd-eov-empty">No programmes with readiness levels for this EOV yet.</p>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
