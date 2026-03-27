'use client'

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback

      return (
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 p-8 text-center">
          <h2 className="text-xl font-semibold text-charcoal-900">
            Algo deu errado
          </h2>
          <p className="text-smoke-600">
            Ocorreu um erro inesperado. Tente novamente.
          </p>
          <button
            type="button"
            onClick={() => this.setState({ hasError: false })}
            className="rounded-md bg-ember-600 px-4 py-2 text-sm font-medium text-white hover:bg-ember-700"
          >
            Tentar novamente
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
