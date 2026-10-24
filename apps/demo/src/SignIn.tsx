import { useAuth } from '@archlast/forge-react'
import { useState, type FormEvent } from 'react'
import { Icon, Logo, type IconName } from './icons'

const FEATURES: { icon: IconName; title: string; text: string }[] = [
  { icon: 'sync', title: 'Live everywhere', text: 'Open two tabs. A change in one shows up in the other the moment it is saved.' },
  { icon: 'bolt', title: 'Instant feel', text: 'Checkboxes flip before the server answers, and settle on the real result.' },
  { icon: 'clip', title: 'Files and search', text: 'Attach files straight to storage, and find any task with full-text search.' },
]

export function SignIn({ themeToggle }: { themeToggle: React.ReactNode }) {
  const auth = useAuth()
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const email = String(f.get('email'))
    const password = String(f.get('password'))
    setBusy(true)
    try {
      const res =
        mode === 'up'
          ? await auth.signUp.email({ email, password, name: String(f.get('name')) })
          : await auth.signIn.email({ email, password })
      setError(res.error?.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="welcome">
      <div className="welcome-top">
        <span className="brand">
          <Logo size={30} />
          <span>
            forge <b>todos</b>
          </span>
        </span>
        {themeToggle}
      </div>
      <main className="welcome-grid">
        <section className="pitch">
          <p className="eyebrow">Built on archlast-forge</p>
          <h1>
            Todos that <span className="ember-text">stay in sync</span>, everywhere.
          </h1>
          <p className="lede">A small app with a real backend: live queries, auth, file storage and search, all from one folder of TypeScript functions.</p>
          <ul className="features">
            {FEATURES.map((f) => (
              <li key={f.title}>
                <span className="feature-icon">
                  <Icon name={f.icon} size={18} />
                </span>
                <span>
                  <strong>{f.title}</strong>
                  <span className="muted">{f.text}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="auth-card" aria-label={mode === 'up' ? 'Create account' : 'Sign in'}>
          <h2>{mode === 'up' ? 'Create your account' : 'Welcome back'}</h2>
          <p className="muted">{mode === 'up' ? 'It takes a few seconds.' : 'Sign in to pick up where you left off.'}</p>
          <form onSubmit={submit} className="stack">
            {mode === 'up' && (
              <label className="field">
                <span>Name</span>
                <input name="name" placeholder="Ada Lovelace" required autoComplete="name" />
              </label>
            )}
            <label className="field">
              <span>Email</span>
              <input name="email" type="email" placeholder="you@example.com" required autoComplete="email" />
            </label>
            <label className="field">
              <span>Password</span>
              <input name="password" type="password" placeholder="8+ characters" minLength={8} required autoComplete={mode === 'up' ? 'new-password' : 'current-password'} />
            </label>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <button type="submit" className="btn primary block" disabled={busy}>
              {mode === 'up' ? 'Create account' : 'Sign in'}
            </button>
          </form>
          <button className="link switch" onClick={() => (setMode(mode === 'in' ? 'up' : 'in'), setError(undefined))}>
            {mode === 'in' ? 'No account? Create one' : 'Have an account? Sign in'}
          </button>
        </section>
      </main>
    </div>
  )
}
