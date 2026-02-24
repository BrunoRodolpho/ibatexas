const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"

export const apiFetch = async (endpoint: string, options?: RequestInit) => {
  const url = `${API_BASE}${endpoint}`
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
    ...options,
  })

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`)
  }

  return response.json()
}

export const apiStream = async (endpoint: string, onChunk: (chunk: unknown) => void) => {
  const url = `${API_BASE}${endpoint}`
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`Stream error: ${response.status}`)
  }

  if (!response.body) {
    throw new Error("No response body")
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })
      const lines = chunk.split("\n")

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6))
            onChunk(data)
          } catch (err) {
            console.warn("Failed to parse chunk:", line)
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
