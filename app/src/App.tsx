import { useEffect, useState } from 'react'
import type { EovVocabulary } from './eovVocabulary'
import { Map } from './components/Map'
import { ProjectList } from './components/ProjectList'
import { AboutOverlay } from './components/AboutOverlay'
import { ProjectDetailDialog } from './components/ProjectDetailDialog'
import './App.css'

const SEARCH_DEBOUNCE_MS = 300
const IOC_LOGO_SRC = `${import.meta.env.BASE_URL}ioc_logo.svg`
const GOOS_LOGO_SRC = `${import.meta.env.BASE_URL}goos_logo.png`

export default function App() {
  const [hoveredProjectId, setHoveredProjectId] = useState<string | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedCellBbox, setSelectedCellBbox] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('')
  const [selectedEovCategories, setSelectedEovCategories] = useState<string[]>([])
  const [eovVocabulary, setEovVocabulary] = useState<EovVocabulary | null>(null)
  const [aboutOpen, setAboutOpen] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearchQuery(searchQuery.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [searchQuery])

  useEffect(() => {
    fetch('/api/eov_vocabulary')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
      .then(setEovVocabulary)
      .catch(() => setEovVocabulary(null))
  }, [])

  return (
    <div className="app">
      <header className="site-header">
      <img src={IOC_LOGO_SRC} alt="IOC logo" className="site-header-logo" />
      <img src={GOOS_LOGO_SRC} alt="GOOS logo" className="site-header-logo" />
      <h1>GOOS BioEco Portal</h1>
        <nav className="site-header-nav" aria-label="Site">
          <button type="button" className="site-header-link" onClick={() => setAboutOpen(true)}>
            About
          </button>
        </nav>
      </header>
      <div className="app-main">
        <Map
          hoveredProjectId={hoveredProjectId}
          selectedCellBbox={selectedCellBbox}
          onCellClick={setSelectedCellBbox}
          selectedEovCategories={selectedEovCategories}
          onEovCategoriesChange={setSelectedEovCategories}
          eovVocabulary={eovVocabulary}
        />
        <aside className="panel">
          <div className="panel-content">
            <ProjectList
              onHoverProject={setHoveredProjectId}
              onSelectProject={setSelectedProjectId}
              cellBbox={selectedCellBbox}
              onClearCellFilter={() => setSelectedCellBbox(null)}
              searchQuery={searchQuery}
              onSearchQueryChange={setSearchQuery}
              debouncedSearchQuery={debouncedSearchQuery}
              eovCategories={selectedEovCategories}
              eovVocabulary={eovVocabulary}
            />
          </div>
        </aside>
        <ProjectDetailDialog
          projectId={selectedProjectId}
          onClose={() => setSelectedProjectId(null)}
        />
      </div>
      <AboutOverlay open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </div>
  )
}
