import { useState } from 'react'
import { Map } from './components/Map'
import { ProjectList } from './components/ProjectList'
import './App.css'

export default function App() {
  const [listOpen, setListOpen] = useState(true)
  const [hoveredProjectId, setHoveredProjectId] = useState<string | null>(null)

  return (
    <div className="app">
      <Map hoveredProjectId={hoveredProjectId} />
      <aside className={`panel ${listOpen ? 'open' : ''}`}>
        <header className="panel-header">
          <h1>GOOS BioEco Portal</h1>
          <button
            type="button"
            className="toggle-list"
            onClick={() => setListOpen((o) => !o)}
            aria-label={listOpen ? 'Close list' : 'Open list'}
          >
            {listOpen ? '◀' : '▶'}
          </button>
        </header>
        {listOpen && (
          <div className="panel-content">
            <ProjectList onHoverProject={setHoveredProjectId} />
          </div>
        )}
      </aside>
    </div>
  )
}
