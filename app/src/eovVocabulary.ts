/** Types and helpers for the EOV vocabulary (from API). */

export interface EovBadge {
  bg: string
  fg: string
}

export interface TopLevelEov {
  url: string
  code: string
  label: string
  badge?: EovBadge
  alt_uris?: string[]
}

export interface Subvariable {
  url: string
  code: string
  label: string
  parent_code: string
  alt_uris?: string[]
}

export interface EovVocabulary {
  version?: string
  top_level_eovs: TopLevelEov[]
  subvariables: Subvariable[]
}

const FALLBACK_PALETTE: EovBadge[] = [
  { bg: '#38bdf8', fg: '#fff' },
  { bg: '#fb7185', fg: '#fff' },
  { bg: '#a78bfa', fg: '#fff' },
  { bg: '#4ade80', fg: '#fff' },
  { bg: '#22d3ee', fg: '#fff' },
  { bg: '#a3e635', fg: '#1a1a1a' },
  { bg: '#2dd4bf', fg: '#fff' },
  { bg: '#e879f9', fg: '#fff' },
]

/** Build a map: URI -> { code, label, badge } for top-level resolution (for display). */
export function buildEovResolver(vocab: EovVocabulary | null): (uri: string) => { code: string; label: string; badge: EovBadge } | null {
  if (!vocab?.top_level_eovs?.length) return () => null

  const byCode = new Map<string, TopLevelEov>()
  for (const t of vocab.top_level_eovs) {
    byCode.set(t.code, t)
  }

  const uriMap = new Map<string, { code: string; label: string; badge: EovBadge }>()
  for (const t of vocab.top_level_eovs) {
    const entry = { code: t.code, label: t.label, badge: t.badge ?? FALLBACK_PALETTE[0] }
    const url = t.url?.trim()
    if (url) uriMap.set(url, entry)
    for (const alt of t.alt_uris ?? []) {
      if (alt?.trim()) uriMap.set(alt.trim(), entry)
    }
  }
  for (const s of vocab.subvariables ?? []) {
    const parent = byCode.get(s.parent_code)
    const entry = parent
      ? { code: parent.code, label: parent.label, badge: parent.badge ?? FALLBACK_PALETTE[0] }
      : { code: s.parent_code, label: s.parent_code, badge: FALLBACK_PALETTE[0] }
    const url = s.url?.trim()
    if (url) uriMap.set(url, entry)
    for (const alt of s.alt_uris ?? []) {
      if (alt?.trim()) uriMap.set(alt.trim(), entry)
    }
  }

  const sortedUrls = [...uriMap.keys()].sort((a, b) => b.length - a.length)

  return (uri: string) => {
    if (!uri?.trim()) return null
    const u = uri.trim()
    if (uriMap.has(u)) return uriMap.get(u)! as { code: string; label: string; badge: EovBadge }
    for (const candidate of sortedUrls) {
      if (u.startsWith(candidate + '/') || u.startsWith(candidate.replace(/\/$/, '') + '/')) {
        return uriMap.get(candidate)! as { code: string; label: string; badge: EovBadge }
      }
    }
    return null
  }
}

export function getFallbackBadge(index: number): EovBadge {
  return FALLBACK_PALETTE[index % FALLBACK_PALETTE.length]
}
