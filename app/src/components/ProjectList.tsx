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

export function ProjectList({ onHoverProject, onSelectProject }: ProjectListProps) {
  const [data, setData] = useState<ProjectsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/projects?size=100')
      .then((r) => {
        if (!r.ok) throw new Error(r.statusText)
        return r.json()
      })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <p className="list-message">Loading projects…</p>
  if (error) return <p className="list-message list-error">Error: {error}</p>
  if (!data?.items?.length) return <p className="list-message">No projects found.</p>

  return (
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
  )
}
