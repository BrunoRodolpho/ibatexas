/** Shared types used across multiple domains. */

export interface HookResult<T> {
  data: T
  loading: boolean
  error: Error | null
}
