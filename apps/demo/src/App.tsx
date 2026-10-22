import { useAction, useAuth, useMutation, useQuery, useSession } from '@archlast-forge/react'
import { Component, useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'

export default function App() {
  const session = useSession()
  if (session.isPending) return <p className="muted center">Loading…</p>
  if (!session.data) return <SignIn />
  return <Todos email={session.data.user.email} />
}

function SignIn() {
  const auth = useAuth()
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [error, setError] = useState<string>()

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const email = String(f.get('email'))
    const password = String(f.get('password'))
    const res =
      mode === 'up'
        ? await auth.signUp.email({ email, password, name: String(f.get('name')) })
        : await auth.signIn.email({ email, password })
    setError(res.error?.message)
  }

  return (
    <main className="card narrow">
      <h1>archlast-forge todos</h1>
      <form onSubmit={submit} className="stack">
        {mode === 'up' && <input name="name" placeholder="Name" required aria-label="Name" />}
        <input name="email" type="email" placeholder="Email" required aria-label="Email" autoComplete="email" />
        <input name="password" type="password" placeholder="Password (8+ characters)" minLength={8} required aria-label="Password" />
        <button type="submit">{mode === 'up' ? 'Create account' : 'Sign in'}</button>
        {error && <p role="alert" className="error">{error}</p>}
      </form>
      <button className="link" onClick={() => setMode(mode === 'in' ? 'up' : 'in')}>
        {mode === 'in' ? 'No account? Create one' : 'Have an account? Sign in'}
      </button>
    </main>
  )
}

function Todos({ email }: { email: string }) {
  const auth = useAuth()
  const lists = useQuery(api.lists.all)
  const createList = useMutation(api.lists.create)
  const [selected, setSelected] = useState<Id<'lists'>>()
  const listId = selected ?? lists?.[0]?._id

  return (
    <main className="layout">
      <header>
        <strong>archlast-forge todos</strong>
        <span className="muted">{email}</span>
        <button className="link" onClick={() => auth.signOut()}>Sign out</button>
      </header>
      <nav className="card">
        <h2>Lists</h2>
        <ul>
          {lists?.map((l) => (
            <li key={l._id}>
              <button className={l._id === listId ? 'selected' : 'link'} onClick={() => setSelected(l._id)}>{l.name}</button>
            </li>
          ))}
        </ul>
        <AddForm placeholder="New list" onAdd={async (name) => setSelected(await createList({ name }))} />
      </nav>
      <section className="card">
        {listId ? (
          <ErrorBoundary>
            <TodoList listId={listId} />
          </ErrorBoundary>
        ) : (
          <p className="muted">Create a list to start.</p>
        )}
      </section>
    </main>
  )
}

function TodoList({ listId }: { listId: Id<'lists'> }) {
  const todos = useQuery(api.todos.listByList, { listId })
  const add = useMutation(api.todos.add)
  const toggle = useMutation(api.todos.toggle)
  const remove = useMutation(api.todos.remove)
  const remind = useAction(api.todos.sendReminder)
  const generateUploadUrl = useMutation(api.todos.generateUploadUrl)
  const attach = useMutation(api.todos.attach)
  const [notice, setNotice] = useState<string>()

  async function upload(todoId: Id<'todos'>, file: File) {
    try {
      const { uploadUrl, storageId } = await generateUploadUrl({ contentType: file.type || undefined })
      // Bytes go straight to S3 via the presigned URL, not through the server.
      const res = await fetch(uploadUrl, { method: 'PUT', body: file, headers: file.type ? { 'content-type': file.type } : {} })
      if (!res.ok) throw new Error(`Upload failed (${res.status})`)
      await attach({ todoId, storageId })
    } catch (e) {
      setNotice((e as Error).message)
    }
  }

  if (!todos) return <p className="muted">Loading…</p>
  return (
    <>
      <AddForm placeholder="What needs doing?" onAdd={(title) => add({ listId, title })} />
      {notice && <p role="status" className="muted">{notice}</p>}
      <ul className="todos">
        {todos.map((t) => (
          <li key={t._id} className={t.done ? 'done' : ''}>
            <label>
              <input type="checkbox" checked={t.done} onChange={() => toggle({ todoId: t._id })} />
              <span>{t.title}</span>
            </label>
            {t.attachmentUrl && <a href={t.attachmentUrl} target="_blank" rel="noreferrer">attachment</a>}
            {t.remindedAt && <span className="muted small">reminded</span>}
            <span className="actions">
              <button className="link" onClick={async () => setNotice(await remind({ todoId: t._id }))}>Remind</button>
              <label className="link">
                Attach
                <input type="file" hidden onChange={(e) => e.target.files?.[0] && upload(t._id, e.target.files[0])} />
              </label>
              <button className="link danger" onClick={() => remove({ todoId: t._id })} aria-label={`Delete ${t.title}`}>Delete</button>
            </span>
          </li>
        ))}
      </ul>
      {todos.length === 0 && <p className="muted">Nothing here yet.</p>}
    </>
  )
}

function AddForm({ placeholder, onAdd }: { placeholder: string; onAdd: (text: string) => Promise<unknown> }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string>()
  return (
    <form
      className="row"
      onSubmit={async (e) => {
        e.preventDefault()
        if (!text.trim()) return
        try {
          await onAdd(text.trim())
          setText('')
          setError(undefined)
        } catch (err) {
          setError((err as Error).message)
        }
      }}
    >
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
      <button type="submit">Add</button>
      {error && <span role="alert" className="error">{error}</span>}
    </form>
  )
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {}
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    return this.state.error ? <p role="alert" className="error">{this.state.error.message}</p> : this.props.children
  }
}
