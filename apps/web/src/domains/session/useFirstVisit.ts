import { useState, useEffect } from 'react'

const STORAGE_KEY = 'ibx_visited'

export function useFirstVisit() {
  const [isFirstVisit, setIsFirstVisit] = useState(false)

  useEffect(() => {
    try {
      const visited = sessionStorage.getItem(STORAGE_KEY)
      if (!visited) {
        setIsFirstVisit(true) // eslint-disable-line react-hooks/set-state-in-effect -- SSR-safe storage read requires effect
        sessionStorage.setItem(STORAGE_KEY, '1')
      }
    } catch {
      // sessionStorage not available
    }
  }, [])

  const dismiss = () => setIsFirstVisit(false)

  return { isFirstVisit, dismiss }
}
