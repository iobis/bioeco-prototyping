import { useEffect, useState } from 'react'
import type { EovVocabulary } from './eovVocabulary'
import { Map } from './components/Map'
import { ProjectList } from './components/ProjectList'
import { AboutPage } from './components/AboutPage'
import { DataQualityPage } from './components/DataQualityPage'
import { ProjectDetailDialog } from './components/ProjectDetailDialog'
import { ReadinessDashboard } from './components/ReadinessDashboard'
import {
  parseUrlState,
  replaceUrlState,
  type AppView,
  type ColorSchemeId,
  type MapLayerMode,
  type PortalUrlState,
} from './urlState'
import './App.css'

const SEARCH_DEBOUNCE_MS = 300
const IOC_LOGO_SRC = `${import.meta.env.BASE_URL}ioc_logo.svg`
const GOOS_LOGO_SRC = `${import.meta.env.BASE_URL}goos_logo.png`

const NAV_ITEMS: Array<{ id: AppView; label: string }> = [
  { id: 'map', label: 'Map' },
  { id: 'readiness', label: 'Readiness' },
  { id: 'data-quality', label: 'Data quality' },
  { id: 'about', label: 'About' },
]

function applyParsedState(
  parsed: PortalUrlState,
  setters: {
    setView: (v: AppView) => void
    setSelectedProjectId: (v: string | null) => void
    setSelectedCellBbox: (v: string | null) => void
    setSearchQuery: (v: string) => void
    setDebouncedSearchQuery: (v: string) => void
    setProgrammeStatus: (v: PortalUrlState['status']) => void
    setSelectedEovCategories: (v: string[]) => void
    setSelectedReadiness: (v: PortalUrlState['readiness']) => void
    setMapLayer: (v: MapLayerMode) => void
    setColorScheme: (v: ColorSchemeId) => void
    setGridOpacity: (v: number) => void
    setShowGridLabels: (v: boolean) => void
    setGlobe: (v: boolean) => void
  },
) {
  setters.setView(parsed.view)
  setters.setSelectedProjectId(parsed.programme)
  setters.setSelectedCellBbox(parsed.bbox)
  setters.setSearchQuery(parsed.q)
  setters.setDebouncedSearchQuery(parsed.q)
  setters.setProgrammeStatus(parsed.status)
  setters.setSelectedEovCategories(parsed.eov)
  setters.setSelectedReadiness(parsed.readiness)
  setters.setMapLayer(parsed.layer)
  setters.setColorScheme(parsed.colour)
  setters.setGridOpacity(parsed.opacity)
  setters.setShowGridLabels(parsed.labels)
  setters.setGlobe(parsed.globe)
}

export default function App() {
  const initial = parseUrlState()
  const [view, setView] = useState<AppView>(initial.view)
  const [hoveredProjectId, setHoveredProjectId] = useState<string | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(initial.programme)
  const [selectedCellBbox, setSelectedCellBbox] = useState<string | null>(initial.bbox)
  const [searchQuery, setSearchQuery] = useState(initial.q)
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState(initial.q)
  const [programmeStatus, setProgrammeStatus] = useState(initial.status)
  const [selectedEovCategories, setSelectedEovCategories] = useState(initial.eov)
  const [selectedReadiness, setSelectedReadiness] = useState(initial.readiness)
  const [mapLayer, setMapLayer] = useState<MapLayerMode>(initial.layer)
  const [colorScheme, setColorScheme] = useState<ColorSchemeId>(initial.colour)
  const [gridOpacity, setGridOpacity] = useState(initial.opacity)
  const [showGridLabels, setShowGridLabels] = useState(initial.labels)
  const [globe, setGlobe] = useState(initial.globe)
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

  useEffect(() => {
    replaceUrlState({
      view,
      programme: selectedProjectId,
      bbox: selectedCellBbox,
      q: debouncedSearchQuery,
      status: programmeStatus,
      eov: selectedEovCategories,
      readiness: selectedReadiness,
      layer: mapLayer,
      colour: colorScheme,
      opacity: gridOpacity,
      labels: showGridLabels,
      globe,
    })
  }, [
    view,
    selectedProjectId,
    selectedCellBbox,
    debouncedSearchQuery,
    programmeStatus,
    selectedEovCategories,
    selectedReadiness,
    mapLayer,
    colorScheme,
    gridOpacity,
    showGridLabels,
    globe,
  ])

  useEffect(() => {
    const onPopState = () => {
      applyParsedState(parseUrlState(), {
        setView,
        setSelectedProjectId,
        setSelectedCellBbox,
        setSearchQuery,
        setDebouncedSearchQuery,
        setProgrammeStatus,
        setSelectedEovCategories,
        setSelectedReadiness,
        setMapLayer,
        setColorScheme,
        setGridOpacity,
        setShowGridLabels,
        setGlobe,
      })
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
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
            mapLayer={mapLayer}
            onMapLayerChange={setMapLayer}
            colorScheme={colorScheme}
            onColorSchemeChange={setColorScheme}
            gridOpacity={gridOpacity}
            onGridOpacityChange={setGridOpacity}
            showGridLabels={showGridLabels}
            onShowGridLabelsChange={setShowGridLabels}
            globe={globe}
            onGlobeChange={setGlobe}
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
