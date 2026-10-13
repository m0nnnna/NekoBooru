// An AbortSignal that fires when `signal` does or after `ms`. Call done()
// when the request settles, so the timer and the parent listener go away.
// Used by the browser-side count and category lookups (Danbooru, e621).
export function timeoutSignal(signal, ms) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal?.aborted) abort()
  else signal?.addEventListener?.('abort', abort, { once: true })
  const timer = setTimeout(abort, ms)
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', abort)
    },
  }
}
