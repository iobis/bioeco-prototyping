import { useEffect, useState } from 'react'
import { Map } from './components/Map'
import { ProjectList } from './components/ProjectList'
import { ProjectDetailDialog } from './components/ProjectDetailDialog'
import './App.css'

const SEARCH_DEBOUNCE_MS = 300

export default function App() {
  const [hoveredProjectId, setHoveredProjectId] = useState<string | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedCellBbox, setSelectedCellBbox] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('')

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearchQuery(searchQuery.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [searchQuery])

  return (
    <div className="app">
      <Map
        hoveredProjectId={hoveredProjectId}
        selectedCellBbox={selectedCellBbox}
        onCellClick={setSelectedCellBbox}
        searchQuery={debouncedSearchQuery}
      />
      <aside className="panel">
        <header className="panel-header">
          <h1>GOOS BioEco Portal</h1>
        </header>
        <div className="panel-content">
          <ProjectList
            onHoverProject={setHoveredProjectId}
            onSelectProject={setSelectedProjectId}
            cellBbox={selectedCellBbox}
            onClearCellFilter={() => setSelectedCellBbox(null)}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            debouncedSearchQuery={debouncedSearchQuery}
          />
        </div>
      </aside>
      <ProjectDetailDialog
        projectId={selectedProjectId}
        onClose={() => setSelectedProjectId(null)}
      />
    </div>
  )
}
