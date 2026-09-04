export type ProgrammeStatus = 'active' | 'inactive' | 'all'

export const PROGRAMME_STATUS_OPTIONS: Array<{ value: ProgrammeStatus; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
]
