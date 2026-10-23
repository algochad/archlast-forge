import { useAuth, useSession } from '@archlast-forge/react'
import { useEffect, useState } from 'react'
import { Icon, Logo, type IconName } from './icons'
import { SignIn } from './SignIn'
import { Todos } from './Todos'

type Theme = 'system' | 'light' | 'dark'
const NEXT: Record<Theme, Theme> = { system: 'dark', dark: 'light', light: 'system' }
const THEME_ICON: Record<Theme, IconName> = { system: 'monitor', dark: 'moon', light: 'sun' }

function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem('forge-todos:theme') as Theme) ?? 'system'
    } catch {
      return 'system'
    }
  })
  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', theme)
    try {
      localStorage.setItem('forge-todos:theme', theme)
    } catch {
      /* private mode: the choice just doesn't persist */
    }
  }, [theme])
  return [theme, setTheme] as const
}

export default function App() {
  const session = useSession()
  const [theme, setTheme] = useTheme()
  const themeToggle = (
    <button className="btn icon" onClick={() => setTheme(NEXT[theme])} aria-label={`Theme: ${theme}. Switch to ${NEXT[theme]}.`} title={`Theme: ${theme}`}>
      <Icon name={THEME_ICON[theme]} />
    </button>
  )
  if (session.isPending)
    return (
      <div className="boot" role="progressbar" aria-label="Loading">
        <Logo size={56} />
      </div>
    )
  if (!session.data) return <SignIn themeToggle={themeToggle} />
  return <Signed email={session.data.user.email} name={session.data.user.name} themeToggle={themeToggle} />
}

function Signed({ email, name, themeToggle }: { email: string; name?: string; themeToggle: React.ReactNode }) {
  const auth = useAuth()
  const initials = (name || email)
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase())
    .join('')
    .slice(0, 2)
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <Logo size={30} />
          <span>
            forge <b>todos</b>
          </span>
        </span>
        <span className="push" />
        {themeToggle}
        <span className="user">
          <span className="avatar" aria-hidden="true">
            {initials}
          </span>
          <span className="who">
            <strong>{name || email}</strong>
            {name && <span className="muted small">{email}</span>}
          </span>
        </span>
        <button className="btn ghost" onClick={() => auth.signOut()}>
          <Icon name="logout" size={16} />
          <span className="label">Sign out</span>
        </button>
      </header>
      <Todos />
    </div>
  )
}
