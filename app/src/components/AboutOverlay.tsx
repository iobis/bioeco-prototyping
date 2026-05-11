import { useEffect } from 'react'

interface AboutOverlayProps {
  open: boolean
  onClose: () => void
}

export function AboutOverlay({ open, onClose }: AboutOverlayProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div
      className="dialog-backdrop"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="about-title"
    >
      <div className="dialog-box dialog-box--about">
        <header className="dialog-header about-dialog-header">
          <h1 id="about-title">About the portal</h1>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="dialog-body about-body">
          <h2>Vision</h2>
          <p>
            <i>A globally connected gateway to sustained marine biodiversity observations, making BioEco
            Essential Ocean Variable monitoring programs visible, discoverable, and actionable.</i>
          </p>

          <h2>What are GOOS BioEco EOVs</h2>
          <p>
            GOOS EOVs are defined as <i>the minimum set of ocean variables that are needed to assess
            ocean state and variability for important global ocean phenomena, and to provide essential
            data for applications that support societal benefit. They are derived from sustained
            individual measurements, or combinations of measurements, that can be undertaken at global
            scale and in a cost-effective manner.</i>
          </p>
          <p>
            GOOS currently recognizes 36 Essential Ocean Variables (EOVs) across physical,
            biogeochemical, biology and ecosystem (BioEco), and some human impact domains. They are
            derived from sustained individual measurements or combinations of measurements that are
            essential for assessing the state and change of the ocean (Martin Miguez, Heslop et al.
            2026).
          </p>
          <p>
            The GOOS BioEco EOVs aim to meet the information needs for understanding and forecasting
            marine life. They provide a framework for coordinating ocean observations in this field,
            ensuring globally comparable and combinable data to support information needs from local to
            global scales.
          </p>

          <h2>Purpose of the Portal</h2>
          <p>
            The GOOS Biology and Ecosystems Metadata Portal (BioEco Portal) is an open-access online
            platform providing metadata and information about sustained ocean observing programs that
            collect data on GOOS BioEco Essential Ocean Variables (EOVs).
          </p>
          <p>
            The Portal makes these programs visible, capturing what is being monitored, the types of
            observations collected, where they are conducted, the spatial and temporal scales at which
            they operate, and where the resulting data can be accessed.
          </p>
          <p>
            Together, this information provides a view of global marine biodiversity monitoring
            coverage and enables the identification of observing gaps, a fundamental starting point for
            improving coordination and directing efforts where they are most needed. This understanding
            supports biological and ecosystem observation at local, subnational, national, and global
            scales, and underpins contributions to international conventions, multilateral environmental
            agreements, and global marine biodiversity assessments.
          </p>

          <h2>What is included in the BioEco Portal</h2>
          <p>
            The Portal includes information about long-term (+5 years) ocean observing programs that
            have been collecting data on BioEco EOVs:
          </p>
          <ul>
            <li>Microbe biomass and diversity</li>
            <li>Phytoplankton biomass and diversity</li>
            <li>Zooplankton biomass and diversity</li>
            <li>Benthic invertebrate biomass and diversity</li>
            <li>Fish abundance and distribution</li>
            <li>Marine birds abundance and distribution</li>
            <li>Marine mammals abundance and distribution</li>
            <li>Marine turtles abundance and distribution</li>
            <li>Macroalgal cover and composition</li>
            <li>Mangrove cover and composition</li>
            <li>Hard coral cover and composition</li>
            <li>Seagrass cover and composition</li>
          </ul>

          <h2>How to use and contribute to the portal?</h2>
          <p>
            The portal provides an interactive map that shows a global picture of the biological and
            ecosystem observations collected by contributing programmes. The Portal allows you to filter
            and select these programmes by name, selecting a locality on the map, or filtering by
            EOVs. The portal provides information about the variables observed, the standardisations and
            specifications used to collect observations, the time of operation and general details about
            the programme.
          </p>
          <p>
            This information is known as the program &apos;metadata&apos;, which can be uploaded to the
            portal using the{' '}
            <a href="https://eovmetadata.obis.org/" target="_blank" rel="noopener noreferrer">
              BioEco Portal metadata App
            </a>
            .
          </p>
          <p>
            Newly contributed programmes and updated programme metadata will automatically be
            incorporated into the GOOS BioEco portal, where users can then observe, compare and connect
            with programmes, researchers and institutions of interest.
          </p>

          <h2>Support &amp; Funding</h2>
          <p>
            Several projects have contributed to the development of this Portal. Financial support was
            provided by:
          </p>
          <ul>
            <li>
              the Intergovernmental Oceanographic Commission of UNESCO, through its regular budget as
              part of GOOS and OBIS,
            </li>
            <li>
              the European Union:
              <ul>
                <li>
                  BioEcoOcean: Co-Creating Transformative Pathways to Biological and Ecosystem Ocean
                  Observations (Grant Agreement No. 101136748)
                </li>
                <li>
                  EuroSea: Improving and Integrating European Ocean Observing and Forecasting Systems
                  (Grant Agreement No. 862626).
                </li>
              </ul>
            </li>
            <li>
              Future Earth and the National Center for Ecological Analysis and Synthesis (NCEAS):
              &quot;Defining the observing system for the world&apos;s oceans—from microbes to
              whales&quot;, funded under the PEGASuS 2 call on Ocean Sustainability
            </li>
          </ul>
          <p className="about-body-note">
            This portal receives technical support from IOC/IODE&apos;s OBIS secretariat based at the IOC
            Project Office for IODE as a service to GOOS.
          </p>
        </div>
      </div>
    </div>
  )
}
