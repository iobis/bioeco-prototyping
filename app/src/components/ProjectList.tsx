import { useEffect, useState } from 'react'

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
}

const SEARCH_DEBOUNCE_MS = 300

/** Top-level biological EOV categories (order for display). More specific keys first so "zooplankton" maps to plankton. */
const TOP_LEVEL_EOV_ORDER: Array<{ key: string; label: string; keywords: string[] }> = [
  { key: 'fish', label: 'Fish', keywords: ['fish'] },
  { key: 'coral', label: 'Coral', keywords: ['coral', 'reef'] },
  { key: 'mammal', label: 'Mammals', keywords: ['mammal'] },
  { key: 'bird', label: 'Birds', keywords: ['bird'] },
  { key: 'turtle', label: 'Turtles', keywords: ['turtle'] },
  { key: 'plankton', label: 'Plankton', keywords: ['plankton', 'zooplankton', 'phytoplankton'] },
  { key: 'seaweed', label: 'Seaweed / algae', keywords: ['seaweed', 'macroalgae', 'seagrass', 'kelp'] },
  { key: 'invertebrate', label: 'Invertebrates', keywords: ['invertebrate', 'benthos'] },
  { key: 'ecosystem', label: 'Ecosystem', keywords: ['ecosystem', 'habitat', 'species', 'abundance', 'distribution', 'marine life'] },
]

function getTopLevelEov(eov: Eov): { key: string; label: string } | null {
  const text = [
    eov.label ?? '',
    eov.name ?? '',
    eov.code ?? '',
    eov.uri ?? '',
  ].join(' ').toLowerCase()
  for (const { key, label, keywords } of TOP_LEVEL_EOV_ORDER) {
    if (keywords.some((kw) => text.includes(kw))) return { key, label }
  }
  return null
}

/** Return biological EOVs grouped by top-level category; one entry per category with all EOV names for tooltip */
function groupEovsByTopLevel(eovs: Eov[]): Array<{ key: string; label: string; bg: string; eovNames: string[] }> {
  const byKey = new Map<string, string[]>()
  for (const eov of eovs) {
    const top = getTopLevelEov(eov)
    if (!top) continue
    const name = (eov.label ?? eov.name ?? eov.code ?? '').trim() || 'EOV'
    const existing = byKey.get(top.key)
    if (existing) existing.push(name)
    else byKey.set(top.key, [name])
  }
  const result: Array<{ key: string; label: string; bg: string; eovNames: string[] }> = []
  for (const { key, label } of TOP_LEVEL_EOV_ORDER) {
    const eovNames = byKey.get(key)
    if (eovNames?.length) {
      const color = EOV_BADGE_COLORS[key] ?? EOV_PALETTE_BRIGHT[result.length % EOV_PALETTE_BRIGHT.length]
      result.push({ key, label, bg: color.bg, eovNames })
    }
  }
  return result
}

/** Light, bright EOV bubbles – same hues, higher lightness */
const EOV_BADGE_COLORS: Record<string, { bg: string; fg: string }> = {
  fish: { bg: '#73C3D0', fg: '#fff' },            // sky blue
  coral: { bg: '#fb7185', fg: '#fff' },           // rose
  mammal: { bg: '#a78bfa', fg: '#fff' },          // violet
  bird: { bg: '#A2A79E', fg: '#fff' },             // green
  turtle: { bg: '#86A59C', fg: '#fff' },          // teal
  plankton: { bg: '#E1CE7A', fg: '#fff' },         // cyan
  seaweed: { bg: '#BFE1B0', fg: '#1a1a1a' },      // lime (dark text)
  invertebrate: { bg: '#F45B69', fg: '#fff' },    // fuchsia
  ecosystem: { bg: '#fb923c', fg: '#fff' },         // orange
}
const EOV_PALETTE_BRIGHT = [
  { bg: '#38bdf8', fg: '#fff' },
  { bg: '#fb7185', fg: '#fff' },
  { bg: '#a78bfa', fg: '#fff' },
  { bg: '#4ade80', fg: '#fff' },
  { bg: '#22d3ee', fg: '#fff' },
  { bg: '#a3e635', fg: '#1a1a1a' },
  { bg: '#2dd4bf', fg: '#fff' },
  { bg: '#e879f9', fg: '#fff' },
]


export function ProjectList({ onHoverProject, onSelectProject, cellBbox = null, onClearCellFilter }: ProjectListProps) {
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
    if (cellBbox?.trim()) params.set('bbox', cellBbox.trim())
    fetch(`/api/projects?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(r.statusText)
        return r.json()
      })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [debouncedQuery, cellBbox])

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
            {(() => {
              const grouped = p.eovs?.length ? groupEovsByTopLevel(p.eovs) : []
              if (!grouped.length) return null
              return (
                <div className="project-eov-badges">
                  {grouped.map(({ key, label, bg, eovNames }) => (
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
