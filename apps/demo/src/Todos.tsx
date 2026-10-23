import { useAction, useMutation, usePaginatedQuery, useQuery, useUploadFile } from '@archlast-forge/react'
import { Component, useEffect, useState, type ReactNode } from 'react'
import { api } from '../forge/_generated/api'
import type { Id } from '../forge/_generated/dataModel'
import { Icon } from './icons'

type Filter = 'all' | 'active' | 'done'

const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  return s < 45 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`
}

export function Todos() {
  const { results: lists, status, loadMore } = usePaginatedQuery(api.lists.page, {}, { initialNumItems: 15 })
  const createList = useMutation(api.lists.create)
  const [selected, setSelected] = useState<Id<'lists'>>()
  const current = lists.find((l) => l._id === selected) ?? lists[0]

  return (
    <main className="layout">
      <nav className="sidebar" aria-label="Lists">
        <div className="side-head">
          <h2>Lists</h2>
          {lists.length > 0 && <span className="count">{lists.length}</span>}
        </div>
        <ul className="lists">
          {lists.map((l) => (
            <li key={l._id}>
              <button className={l._id === current?._id ? 'selected' : 'link'} onClick={() => setSelected(l._id)}>
                <Icon name="list" size={16} />
                <span>{l.name}</span>
              </button>
            </li>
          ))}
        </ul>
        {status === 'CanLoadMore' && (
          <button className="link more" onClick={() => loadMore(15)}>
            Load more lists
          </button>
        )}
        <AddForm placeholder="New list" label="Add list" onAdd={async (name) => setSelected(await createList({ name }))} compact />
      </nav>
      <section className="board">
        {current ? (
          <ErrorBoundary key={current._id}>
            <TodoList listId={current._id} name={current.name} />
          </ErrorBoundary>
        ) : status === 'LoadingFirstPage' ? (
          <div className="skeleton" role="progressbar" aria-label="Loading lists">
            <span style={{ width: '40%' }} />
            <span style={{ width: '90%' }} />
            <span style={{ width: '75%' }} />
          </div>
        ) : (
          <div className="empty">
            <span className="empty-icon">
              <Icon name="flame" size={26} />
            </span>
            <h2>Light the forge</h2>
            <p className="muted">Create your first list to start adding tasks.</p>
          </div>
        )}
      </section>
    </main>
  )
}

function TodoList({ listId, name }: { listId: Id<'lists'>; name: string }) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const all = useQuery(api.todos.listByList, { listId })
  const found = useQuery(api.todos.search, search.trim() ? { listId, text: search } : 'skip')
  // Until search results arrive, keep showing the list (the search box stays mounted and focused).
  const matches = search.trim() && found ? found.map((t) => ({ ...t, attachmentUrl: all?.find((a) => a._id === t._id)?.attachmentUrl ?? null })) : all
  const add = useMutation(api.todos.add)
  // Optimistic: the checkbox flips at once; the live result replaces it (or it's undone on error).
  const toggle = useMutation(api.todos.toggle).withOptimisticUpdate((store, { todoId }) => {
    const current = store.getQuery(api.todos.listByList, { listId })
    if (current) store.setQuery(api.todos.listByList, { listId }, current.map((t) => (t._id === todoId ? { ...t, done: !t.done } : t)))
  })
  const remove = useMutation(api.todos.remove)
  const remind = useAction(api.todos.sendReminder)
  const uploadFile = useUploadFile(api.todos.generateUploadUrl)
  const attach = useMutation(api.todos.attach)
  const [notice, setNotice] = useState<string>()

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(undefined), 5000)
    return () => clearTimeout(timer)
  }, [notice])

  async function upload(todoId: Id<'todos'>, file: File) {
    try {
      // Bytes go straight to storage through a presigned URL, not through the server.
      await attach({ todoId, storageId: await uploadFile(file) })
    } catch (e) {
      setNotice((e as Error).message)
    }
  }

  const total = all?.length ?? 0
  const done = all?.filter((t) => t.done).length ?? 0
  const todos = matches?.filter((t) => (filter === 'active' ? !t.done : filter === 'done' ? t.done : true))
  const complete = total > 0 && done === total

  return (
    <>
      <header className={`board-head ${complete ? 'complete' : ''}`}>
        <div>
          <h1>{name}</h1>
          <p className="muted">{!all ? 'Loading…' : total === 0 ? 'No tasks yet' : complete ? 'All done. Nicely forged.' : `${done} of ${total} done`}</p>
        </div>
        {total > 0 && (
          <div className="progress" role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
            <i style={{ width: `${(done / total) * 100}%` }} />
          </div>
        )}
      </header>

      <AddForm placeholder="What needs doing?" label="Add task" onAdd={(title) => add({ listId, title })} />

      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Show">
          {(['all', 'active', 'done'] as const).map((f) => (
            <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'active' ? 'Active' : 'Done'}
              {all && <span className="count">{f === 'all' ? total : f === 'active' ? total - done : done}</span>}
            </button>
          ))}
        </div>
        <label className="searchbox">
          <Icon name="search" size={16} />
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search this list" aria-label="Search this list" />
        </label>
      </div>

      {!todos ? (
        <div className="skeleton" role="progressbar" aria-label="Loading tasks">
          <span style={{ width: '70%' }} />
          <span style={{ width: '55%' }} />
          <span style={{ width: '82%' }} />
        </div>
      ) : (
        <ul className="todos">
          {todos.map((t) => (
            <li key={t._id} className={t.done ? 'done' : ''}>
              <label className="check">
                <input type="checkbox" checked={t.done} onChange={() => toggle({ todoId: t._id })} />
                <span className="title">{t.title}</span>
              </label>
              <span className="meta">
                {t.attachmentUrl && (
                  <a className="chip" href={t.attachmentUrl} target="_blank" rel="noreferrer">
                    <Icon name="clip" size={13} />
                    attachment
                  </a>
                )}
                {t.remindedAt && (
                  <span className="chip warm">
                    <Icon name="bell" size={13} />
                    reminded
                  </span>
                )}
                <time className="when" dateTime={new Date(t._creationTime).toISOString()}>
                  {ago(t._creationTime)}
                </time>
              </span>
              <span className="actions">
                <button className="btn icon" onClick={async () => setNotice(await remind({ todoId: t._id }))} aria-label="Remind" title="Send a reminder">
                  <Icon name="bell" size={16} />
                </button>
                <label className="btn icon" title="Attach a file">
                  <Icon name="clip" size={16} />
                  <span className="sr-only">Attach</span>
                  <input type="file" className="sr-only" onChange={(e) => e.target.files?.[0] && upload(t._id, e.target.files[0])} />
                </label>
                <button className="btn icon danger" onClick={() => remove({ todoId: t._id })} aria-label={`Delete ${t.title}`} title="Delete">
                  <Icon name="trash" size={16} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {todos?.length === 0 && (
        <div className="empty">
          <span className="empty-icon">
            <Icon name={search.trim() ? 'search' : 'check'} size={26} />
          </span>
          <p>{search.trim() ? 'No matches.' : filter === 'done' ? 'Nothing done yet.' : filter === 'active' && total > 0 ? 'Everything is done.' : 'Nothing here yet.'}</p>
          {!search.trim() && filter === 'all' && <span className="muted small">Add the first task above.</span>}
        </div>
      )}
      {notice && (
        <p role="status" className="toast">
          {notice}
        </p>
      )}
    </>
  )
}

function AddForm({ placeholder, label, onAdd, compact }: { placeholder: string; label: string; onAdd: (text: string) => Promise<unknown>; compact?: boolean }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  return (
    <form
      className={`composer ${compact ? 'compact' : ''}`}
      onSubmit={async (e) => {
        e.preventDefault()
        if (!text.trim() || busy) return
        setBusy(true)
        try {
          await onAdd(text.trim())
          setText('')
          setError(undefined)
        } catch (err) {
          setError((err as Error).message)
        } finally {
          setBusy(false)
        }
      }}
    >
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
      <button type="submit" className="btn primary" disabled={!text.trim() || busy} aria-label={label} title={label}>
        <Icon name="plus" size={18} />
        {!compact && <span className="label">Add</span>}
      </button>
      {error && (
        <span role="alert" className="error">
          {error}
        </span>
      )}
    </form>
  )
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {}
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    return this.state.error ? (
      <p role="alert" className="error">
        {this.state.error.message}
      </p>
    ) : (
      this.props.children
    )
  }
}
