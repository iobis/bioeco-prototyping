import { useEffect, useState } from 'react'

interface Project {
  id: string
  name: string
  description?: string
  url?: string
}

interface ProjectsResponse {
  total: number
  items: Project[]
}

interface ProjectListProps {
  onHoverProject?: (projectId: string | null) => void
  onSelectProject?: (projectId: string) => void
}

const SEARCH_DEBOUNCE_MS = 300

export function ProjectList({ onHoverProject, onSelectProject }: ProjectListProps) {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [data, setData] = useState<ProjectsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    setLoading(true)
    const params = new URLSearchParams({ size: '100' })
    if (debouncedQuery) params.set('name', debouncedQuery)
    fetch(`/api/projects?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(r.statusText)
        return r.json()
      })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [debouncedQuery])

  return (
    <>
      <div className="panel-search">
        <input
          type="search"
          className="search-input"
          placeholder="Search projects…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search projects"
        />
      </div>
      {loading && <p className="list-message">Loading projects…</p>}
      {error && <p className="list-message list-error">Error: {error}</p>}
      {!loading && !error && (!data?.items?.length) && (
        <p className="list-message">
          {debouncedQuery ? `No projects found for “${debouncedQuery}”.` : 'No projects found.'}
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
          </button>
        </li>
      ))}
    </ul>
      ) : null}
    </>
  )
}
