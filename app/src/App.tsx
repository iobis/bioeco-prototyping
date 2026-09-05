import { useEffect, useState } from 'react'
import type { EovVocabulary } from './eovVocabulary'
import type { ProgrammeStatus } from './programmeStatus'
import { EMPTY_READINESS_SELECTION, type ReadinessSelection } from './readiness'
import { Map } from './components/Map'
import { ProjectList } from './components/ProjectList'
import { AboutPage } from './components/AboutPage'
import { DataQualityPage } from './components/DataQualityPage'
import { ProjectDetailDialog } from './components/ProjectDetailDialog'
import { ReadinessDashboard } from './components/ReadinessDashboard'
import './App.css'

const SEARCH_DEBOUNCE_MS = 300
const IOC_LOGO_SRC = `${import.meta.env.BASE_URL}ioc_logo.svg`
const GOOS_LOGO_SRC = `${import.meta.env.BASE_URL}goos_logo.png`

type AppView = 'map' | 'readiness' | 'data-quality' | 'about'

const NAV_ITEMS: Array<{ id: AppView; label: string }> = [
  { id: 'map', label: 'Map' },
  { id: 'readiness', label: 'Readiness' },
  { id: 'data-quality', label: 'Data quality' },
  { id: 'about', label: 'About' },
]

export default function App() {
  const [view, setView] = useState<AppView>('map')
  const [hoveredProjectId, setHoveredProjectId] = useState<string | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedCellBbox, setSelectedCellBbox] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('')
  const [programmeStatus, setProgrammeStatus] = useState<ProgrammeStatus>('all')
  const [selectedEovCategories, setSelectedEovCategories] = useState<string[]>([])
  const [selectedReadiness, setSelectedReadiness] = useState<ReadinessSelection>(EMPTY_READINESS_SELECTION)
  const [eovVocabulary, setEovVocabulary] = useState<EovVocabulary | null>(null)

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
        <img src={IOC_LOGO_SRC} alt="IOC logo" className="site-header-logo site-header-logo--ioc" />
        <img src={GOOS_LOGO_SRC} alt="GOOS logo" className="site-header-logo" />
        <h1>
          <a href="/">GOOS BioEco Portal</a>
        </h1>
        <nav className="site-header-nav" aria-label="Site">
          <div className="site-header-nav-actions">
            <a
              href="https://eovmetadata.obis.org/home"
              target="_blank"
              rel="noopener noreferrer"
              className="site-header-submit-btn"
            >
              Submit or update an entry
            </a>
            <a
              href="https://github.com/iobis/bioeco-prototyping/issues/new"
              target="_blank"
              rel="noopener noreferrer"
              className="site-header-submit-btn"
            >
              Send Feedback
            </a>
          </div>
          <div className="site-header-nav-links">
            {NAV_ITEMS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                className={`site-header-link${view === id ? ' is-active' : ''}`}
                aria-pressed={view === id}
                onClick={() => setView(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </nav>
      </header>
      {view === 'map' ? (
        <div className="app-main">
          <Map
            hoveredProjectId={hoveredProjectId}
            selectedCellBbox={selectedCellBbox}
            onCellClick={setSelectedCellBbox}
            selectedEovCategories={selectedEovCategories}
            onEovCategoriesChange={setSelectedEovCategories}
            eovVocabulary={eovVocabulary}
            programmeStatus={programmeStatus}
            onProgrammeStatusChange={setProgrammeStatus}
            selectedReadiness={selectedReadiness}
            onReadinessChange={setSelectedReadiness}
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
                programmeStatus={programmeStatus}
                readiness={selectedReadiness}
              />
            </div>
          </aside>
          <ProjectDetailDialog
            projectId={selectedProjectId}
            onClose={() => setSelectedProjectId(null)}
          />
        </div>
      ) : (
        <div className="app-main app-main--page">
          {view === 'readiness' && <ReadinessDashboard eovVocabulary={eovVocabulary} />}
          {view === 'data-quality' && <DataQualityPage />}
          {view === 'about' && <AboutPage />}
        </div>
      )}
    </div>
  )
}
