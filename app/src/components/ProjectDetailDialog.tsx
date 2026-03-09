import { useEffect, useState } from 'react'

export interface ProjectDetail {
  id?: string
  name: string
  description?: string
  url?: string
  start_year?: number
  end_year?: number
  eovs?: Array<{ code?: string; name?: string; uri?: string }>
  contacts?: Array<{ name?: string; email?: string; url?: string; contact_type?: string }>
}

interface ProjectDetailDialogProps {
  projectId: string | null
  onClose: () => void
}

export function ProjectDetailDialog({ projectId, onClose }: ProjectDetailDialogProps) {
  const [project, setProject] = useState<ProjectDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!projectId) {
      setProject(null)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    fetch(`/api/projects/${projectId}`)
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 404 ? 'Project not found' : r.statusText)
        return r.json()
      })
      .then(setProject)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [projectId])

  if (projectId == null) return null

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div className="dialog-backdrop" onClick={handleBackdropClick} role="dialog" aria-modal="true" aria-labelledby="dialog-title">
      <div className="dialog-box">
        <header className="dialog-header">
          <h2 id="dialog-title" className="dialog-title">Project details</h2>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="dialog-body">
          {loading && <p className="dialog-message">Loading…</p>}
          {error && <p className="dialog-message dialog-error">{error}</p>}
          {project && !loading && (
            <>
              <h3 className="dialog-project-name">{project.name}</h3>
              {project.description && (
                <p className="dialog-description">{project.description}</p>
              )}
              {(project.start_year != null || project.end_year != null) && (
                <p className="dialog-meta">
                  <span className="dialog-meta-label">Period</span>{' '}
                  {project.start_year ?? '?'} – {project.end_year ?? '?'}
                </p>
              )}
              {project.eovs?.length ? (
                <div className="dialog-section">
                  <span className="dialog-meta-label">EOVs</span>
                  <ul className="dialog-eov-list">
                    {project.eovs.map((eov, i) => (
                      <li key={i}>{eov.name ?? eov.code ?? eov.uri ?? '—'}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {project.contacts?.length ? (
                <div className="dialog-section">
                  <span className="dialog-meta-label">Contacts</span>
                  <ul className="dialog-eov-list">
                    {project.contacts.map((c, i) => {
                      const parts: string[] = []
                      if (c.name) parts.push(c.name)
                      // if (c.contact_type) parts.push(c.contact_type)
                      return (
                        <li key={i}>
                          {parts.join(' – ')}
                          {c.email && (
                            <>
                              {' – '}
                              <a href={`mailto:${c.email}`} className="dialog-link dialog-link-muted">
                                {c.email}
                              </a>
                            </>
                          )}
                          {c.url && (
                            <>
                              {' – '}
                              <a href={c.url} target="_blank" rel="noopener noreferrer" className="dialog-link dialog-link-muted">
                                Link
                              </a>
                            </>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ) : null}
              {project.url && (
                <p className="dialog-actions">
                  <a href={project.url} target="_blank" rel="noopener noreferrer" className="dialog-link">
                    Open project link
                  </a>
                  <a href={`/api/projects/${projectId}`} target="_blank" rel="noopener noreferrer" className="dialog-link dialog-link-muted">
                    View raw API
                  </a>
                </p>
              )}
              {!project.url && (
                <p className="dialog-actions">
                  <a href={`/api/projects/${projectId}`} target="_blank" rel="noopener noreferrer" className="dialog-link dialog-link-muted">
                    View raw API
                  </a>
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
