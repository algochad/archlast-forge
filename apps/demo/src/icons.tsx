import { useId } from 'react'

/** The forge mark: an anvil struck by a spark, in ember. */
export function Logo({ size = 28 }: { size?: number }) {
  const id = useId()
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="logo">
      <defs>
        <linearGradient id={`${id}-ember`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="var(--ember-deep)" />
          <stop offset="0.55" stopColor="var(--ember)" />
          <stop offset="1" stopColor="var(--spark)" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill="var(--logo-bg)" />
      <path
        d="M6 12.5h13.5c0 2.3 1.8 3.8 4.5 3.8v1.6h-4c-1.2 0-1.9.7-1.9 1.8v1.5h2.2v3.3H10.6v-3.3h2.2v-1.5c0-1.1-.7-1.8-1.8-1.8C8.1 17.9 6 15.6 6 12.5z"
        fill={`url(#${id}-ember)`}
      />
      <path d="M22.6 5.2l-1 2.6M26.6 7.4l-2.3 1.5M27.4 11.6h-2.6" stroke="var(--spark)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

const PATHS = {
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3',
  bell: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  clip: 'M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  list: 'M8 6h12M8 12h12M8 18h12M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  monitor: 'M3 5h18v11H3zM8 20h8M12 16v4',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  flame: 'M12 22c4 0 7-2.8 7-6.8 0-3.6-2.4-6.1-4.2-8.2-.4 1.9-1.5 3-2.8 3.3.4-3-1-6-3.5-8.3C8.3 6.6 5 9.4 5 15.2 5 19.2 8 22 12 22z',
  sync: 'M21 12a9 9 0 0 1-15.5 6.2M3 12a9 9 0 0 1 15.5-6.2M18.5 2v4h-4M5.5 22v-4h4',
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon">
      <path d={PATHS[name]} />
    </svg>
  )
}
