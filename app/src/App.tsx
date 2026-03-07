import { useState } from 'react'
import { Map } from './components/Map'
import { ProjectList } from './components/ProjectList'
import { ProjectDetailDialog } from './components/ProjectDetailDialog'
import './App.css'

export default function App() {
  const [hoveredProjectId, setHoveredProjectId] = useState<string | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedCellBbox, setSelectedCellBbox] = useState<string | null>(null)

  return (
    <div className="app">
      <Map
        hoveredProjectId={hoveredProjectId}
        selectedCellBbox={selectedCellBbox}
        onCellClick={setSelectedCellBbox}
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
