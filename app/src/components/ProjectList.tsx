import { useEffect, useMemo, useState } from 'react'
import { buildEovResolver } from '../eovVocabulary'
import type { EovVocabulary } from '../eovVocabulary'

interface Eov {
  code?: string
  label?: string
  name?: string
  uri?: string
}

interface Project {
  id: string
  name: string
  description?: string
  url?: string
  eovs?: Eov[]
}

interface ProjectsResponse {
  total: number
  items: Project[]
}

interface ProjectListProps {
  onHoverProject?: (projectId: string | null) => void
  onSelectProject?: (projectId: string) => void
  cellBbox?: string | null
  onClearCellFilter?: () => void
  searchQuery?: string
  onSearchQueryChange?: (q: string) => void
  debouncedSearchQuery?: string
  eovCategories?: string[]
  eovVocabulary?: EovVocabulary | null
}

/** Group project EOVs by top-level category using vocabulary resolver; return entries with label and badge bg. */
function groupEovsByTopLevel(
  eovs: Eov[],
  resolve: (uri: string) => { code: string; label: string; badge: { bg: string; fg: string } } | null
): Array<{ key: string; label: string; bg: string }> {
  const byKey = new Map<string, { label: string; bg: string }>()
  for (const eov of eovs) {
    const uri = (eov.uri ?? eov.code ?? '').trim()
    const resolved = uri ? resolve(uri) : null
    if (!resolved) continue
    if (!byKey.has(resolved.code)) {
      byKey.set(resolved.code, { label: resolved.label, bg: resolved.badge.bg })
    }
  }
  return [...byKey.entries()].map(([key, { label, bg }]) => ({ key, label, bg }))
}


export function ProjectList({
  onHoverProject,
  onSelectProject,
  cellBbox = null,
  onClearCellFilter,
  searchQuery = '',
  onSearchQueryChange,
  debouncedSearchQuery = '',
  eovCategories = [],
  eovVocabulary = null,
}: ProjectListProps) {
  const [data, setData] = useState<ProjectsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const resolveEov = useMemo(() => buildEovResolver(eovVocabulary), [eovVocabulary])

  useEffect(() => {
    setLoading(true)
    const params = new URLSearchParams({ size: '100' })
    if (debouncedSearchQuery) params.set('name', debouncedSearchQuery)
    if (cellBbox?.trim()) params.set('bbox', cellBbox.trim())
    if (eovCategories.length) params.set('eov_category', eovCategories.join(','))
    fetch(`/api/projects?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(r.statusText)
        return r.json()
      })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [debouncedSearchQuery, cellBbox, eovCategories])

  return (
    <>
      {cellBbox && onClearCellFilter && (
        <div className="panel-cell-filter">
          <span className="panel-cell-filter-label">Map cell filter active</span>
          <button type="button" className="panel-cell-filter-clear" onClick={onClearCellFilter}>
            Clear
          </button>
        </div>
      )}
      <div className="panel-search">
        <input
          type="search"
          className="search-input"
          placeholder="Search projects…"
          value={searchQuery}
          onChange={(e) => onSearchQueryChange?.(e.target.value)}
          aria-label="Search projects"
        />
      </div>
      {loading && <p className="list-message">Loading projects…</p>}
      {error && <p className="list-message list-error">Error: {error}</p>}
      {!loading && !error && (!data?.items?.length) && (
        <p className="list-message">
          {debouncedSearchQuery ? `No projects found for “${debouncedSearchQuery}”.` : 'No projects found.'}
        </p>
      )}
      {!loading && !error && data?.items?.length ? (
    <ul className="project-list">
      {data.items.map((p) => (
        <li
          key={p.id}
          className="project-item"
          onMouseEnter={() => onHoverProject?.(p.id)}
          onMouseLeave={() => onHoverProject?.(null)}
        >
          <button
            type="button"
            className="project-card-button"
            onClick={() => onSelectProject?.(p.id)}
          >
            <span className="project-link">{p.name}</span>
            {p.description && (
              <p className="project-desc">{p.description.slice(0, 120)}{p.description.length > 120 ? '…' : ''}</p>
            )}
            {(() => {
              const grouped = p.eovs?.length ? groupEovsByTopLevel(p.eovs, resolveEov) : []
              if (!grouped.length) return null
              return (
                <div className="project-eov-badges">
                  {grouped.map(({ key, label, bg }) => (
                    <span
                      key={key}
                      className="project-eov-bubble"
                      style={{ backgroundColor: bg }}
                      title={label}
                      aria-label={label}
                    />
                  ))}
                </div>
              )
            })()}
          </button>
        </li>
      ))}
    </ul>
      ) : null}
    </>
  )
}
