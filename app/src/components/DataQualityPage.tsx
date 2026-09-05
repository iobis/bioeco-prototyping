import { useEffect, useMemo, useState } from 'react'

export interface ImportIssue {
  level: string
  code: string
  source: string
  message: string
}

export interface ImportRun {
  run_id: string
  source: string
  started_at?: string
  finished_at?: string
  stats: Record<string, unknown>
  issue_counts: Record<string, number>
  issue_total: number
  issues?: ImportIssue[]
}

type LevelFilter = 'ALL' | 'ERROR' | 'WARN' | 'INFO'

function formatWhen(iso?: string): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
  } catch {
    return iso
  }
}

export function DataQualityPage() {
  const [run, setRun] = useState<ImportRun | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('ALL')
  const [codeFilter, setCodeFilter] = useState<string>('ALL')

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch('/api/import-runs/latest')
      .then((r) => {
        if (r.status === 404) {
          throw new Error('No import run has been recorded yet. Run the metadata loader first.')
        }
        if (!r.ok) throw new Error(r.statusText)
        return r.json()
      })
      .then((data: ImportRun) => setRun(data))
      .catch((e: Error) => {
        setRun(null)
        setError(e.message)
      })
      .finally(() => setLoading(false))
  }, [])

  const codes = useMemo(() => {
    if (!run?.issue_counts) return []
    return Object.keys(run.issue_counts).sort(
      (a, b) => (run.issue_counts[b] || 0) - (run.issue_counts[a] || 0),
    )
  }, [run])

  const filteredIssues = useMemo(() => {
    const issues = run?.issues || []
    return issues.filter((i) => {
      if (levelFilter !== 'ALL' && i.level !== levelFilter) return false
      if (codeFilter !== 'ALL' && i.code !== codeFilter) return false
      return true
    })
  }, [run, levelFilter, codeFilter])

  const stats = run?.stats || {}

  return (
    <div className="content-page">
      <header className="content-page-header">
        <h2 className="content-page-title">Data quality report</h2>
        <p className="content-page-subtitle">
          Issues and indexing stats from the most recent metadata import.
        </p>
      </header>

      <div className="content-page-body import-report-body">
        {loading && <p className="list-message">Loading…</p>}
        {error && <p className="list-message list-error">{error}</p>}
        {run && !loading && (
          <>
            <p className="import-report-meta">
              Last sync: <strong>{formatWhen(run.finished_at)}</strong>
            </p>

            <h2>Indexing summary</h2>
            <dl className="import-report-stats">
              <div>
                <dt>Programmes total</dt>
                <dd>{String(stats.projects_total ?? '—')}</dd>
              </div>
              <div>
                <dt>Indexed</dt>
                <dd>{String(stats.projects_indexed ?? '—')}</dd>
              </div>
              <div>
                <dt>Not indexed</dt>
                <dd>{String(stats.projects_not_indexed ?? '—')}</dd>
              </div>
              <div>
                <dt>Geometry normalized</dt>
                <dd>{String(stats.geometry_normalized ?? '—')}</dd>
              </div>
              <div>
                <dt>Issues recorded</dt>
                <dd>{run.issue_total}</dd>
              </div>
            </dl>

            <h2>Issue counts</h2>
            {codes.length === 0 ? (
              <p>No import issues recorded for this run.</p>
            ) : (
              <ul className="import-report-counts">
                {codes.map((code) => {
                  const level = code.startsWith('ERR')
                    ? 'ERROR'
                    : code.startsWith('WARN')
                      ? 'WARN'
                      : 'INFO'
                  return (
                    <li key={code}>
                      <span className={`import-report-level import-report-level--${level.toLowerCase()}`}>
                        {level}
                      </span>
                      <button
                        type="button"
                        className="import-report-code-btn"
                        onClick={() => setCodeFilter(code)}
                      >
                        {code}
                      </button>
                      <span className="import-report-count">{run.issue_counts[code]}</span>
                    </li>
                  )
                })}
              </ul>
            )}

            <h2>Issues</h2>
            <div className="import-report-filters">
              <label>
                Level{' '}
                <select
                  value={levelFilter}
                  onChange={(e) => setLevelFilter(e.target.value as LevelFilter)}
                >
                  <option value="ALL">All</option>
                  <option value="ERROR">ERROR</option>
                  <option value="WARN">WARN</option>
                  <option value="INFO">INFO</option>
                </select>
              </label>
              <label>
                Code{' '}
                <select value={codeFilter} onChange={(e) => setCodeFilter(e.target.value)}>
                  <option value="ALL">All</option>
                  {codes.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {filteredIssues.length === 0 ? (
              <p>No issues match the current filters.</p>
            ) : (
              <ul className="import-report-issues">
                {filteredIssues.map((issue, idx) => (
                  <li key={`${issue.code}-${issue.source}-${idx}`}>
                    <div className="import-report-issue-head">
                      <span
                        className={`import-report-level import-report-level--${String(issue.level).toLowerCase()}`}
                      >
                        {issue.level}
                      </span>
                      <code>{issue.code}</code>
                      <span className="import-report-source">{issue.source}</span>
                    </div>
                    <p className="import-report-message">{issue.message}</p>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  )
}
