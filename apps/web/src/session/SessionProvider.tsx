import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ApiError, apiDownload, apiRequest, type RequestOptions } from '../api/client'
import type { LoginResponse, SessionUser } from '../api/types'
import { SessionContext, type SessionValue } from './session-context'

interface ActiveSession {
  token: string
  user: SessionUser
  expiresAt: number
}

const EXPIRED = 'Tu sesión venció o ya no está habilitada. Inicia sesión de nuevo.'

// The access token lives only in memory: reloading the page requires a new
// login. There is no refresh token yet.
export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<ActiveSession | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const logout = useCallback((message?: string) => {
    setSession(null)
    setNotice(message ?? null)
  }, [])

  useEffect(() => {
    if (!session) return
    const timer = window.setTimeout(
      () => logout('Tu sesión venció. Inicia sesión de nuevo.'),
      Math.max(0, session.expiresAt - Date.now()),
    )
    return () => window.clearTimeout(timer)
  }, [session, logout])

  const login = useCallback(async (email: string, password: string) => {
    const { data } = await apiRequest<LoginResponse>('/auth/login', null, {
      method: 'POST',
      body: { email, password },
    })
    setSession({
      token: data.access_token,
      user: data.user,
      expiresAt: Date.now() + data.expires_in * 1000,
    })
    setNotice(null)
  }, [])

  const token = session?.token ?? null
  const request = useCallback(
    async <T,>(path: string, options?: RequestOptions) => {
      if (!token) throw new ApiError(401, 'Debes iniciar sesión.')
      try {
        return await apiRequest<T>(path, token, options)
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) logout(EXPIRED)
        throw error
      }
    },
    [token, logout],
  )

  const download = useCallback(
    async (path: string) => {
      if (!token) throw new ApiError(401, 'Debes iniciar sesión.')
      try {
        return await apiDownload(path, token)
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) logout(EXPIRED)
        throw error
      }
    },
    [token, logout],
  )

  const value = useMemo<SessionValue>(
    () => ({ user: session?.user ?? null, notice, login, logout, request, download }),
    [session, notice, login, logout, request, download],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}
