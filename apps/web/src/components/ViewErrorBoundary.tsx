import { Component, type ErrorInfo, type ReactNode } from 'react'

// If a screen fails while drawing, React would otherwise unmount the whole
// app (white screen). This keeps the menu and shows what failed, so the user
// can continue and report the exact message. The App remounts it (key) on
// every change of screen.
export class ViewErrorBoundary extends Component<
  { children: ReactNode; onHome: () => void },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Error al mostrar la pantalla', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <section className="card view-error" role="alert">
        <h2 className="subtitle">Esta pantalla no se pudo mostrar</h2>
        <p>
          No se perdió nada del inventario: el error ocurrió al dibujar la pantalla. Intenta de nuevo; si se repite, recarga la página
          (Ctrl+F5) y envía este mensaje a soporte:
        </p>
        <pre className="view-error-detail">{error.message || String(error)}</pre>
        <div className="actions">
          <button type="button" className="button" onClick={() => this.setState({ error: null })}>
            Intentar de nuevo
          </button>
          <button type="button" className="button button-secondary" onClick={this.props.onHome}>
            Ir al inicio
          </button>
        </div>
      </section>
    )
  }
}
