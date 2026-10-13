// A plain left click on an external search link whose tag name has to be
// looked up first (Sankaku's and e621's spellings differ from the library's).
// Middle and modified clicks keep the link's own fallback href. Returns the
// name searched, which the caller keeps so the next click goes straight there.
//
// `known` is a name already resolved; `fallback` the booru spelling;
// `resolve()` resolves to the name (or throws); `urlFor(name)` builds the URL.
export async function openResolvedSearch(event, { known, fallback, resolve, urlFor }, deps = {}) {
  if (known || event?.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
    return known || ''
  }
  event.preventDefault()
  const openWindow = deps.openWindow || ((url) => window.open(url, '_blank'))

  // Opened inside the click so the popup blocker allows it, then pointed at
  // the search once the name is known.
  const target = openWindow('about:blank')
  let name = fallback
  try {
    name = (await resolve()) || fallback
  } catch {
    // The booru spelling is still a reasonable search.
  }
  const url = urlFor(name)
  if (target) {
    try { target.opener = null } catch { /* cross-origin already */ }
    target.location.href = url
  } else {
    window.location.assign(url)
  }
  return name
}
