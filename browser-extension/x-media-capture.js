// Runs in the page's MAIN world on X/Twitter. It observes the same GraphQL
// responses the page receives after authenticating normally, then forwards the
// response body to the isolated content script for parsing/caching.

(() => {
  const GRAPHQL_TWEET_ENDPOINT = /^(?:\/i\/api)?\/graphql\/[^/]+\/(?:TweetDetail|TweetResultByRestId|UserTweets|UserMedia|HomeTimeline|HomeLatestTimeline|UserTweetsAndReplies|UserHighlightsTweets|UserArticlesTweets|Bookmarks|Likes|CommunitiesExploreTimeline|ListLatestTweetsTimeline|SearchTimeline)$/
  const EVENT_NAME = 'nekobooru:x-media-response'

  function toUrl(raw) {
    try {
      return raw instanceof URL ? raw : new URL(raw, location.origin)
    } catch {
      return null
    }
  }

  function emitBody(rawUrl, status, body) {
    if (status !== 200 || typeof body !== 'string' || !body) return
    const url = toUrl(rawUrl)
    if (!url || !GRAPHQL_TWEET_ENDPOINT.test(url.pathname)) return
    document.dispatchEvent(new CustomEvent(EVENT_NAME, {
      detail: {
        path: url.pathname,
        body,
      },
    }))
  }

  function emitXhrResponse(xhr) {
    emitBody(xhr.responseURL, xhr.status, xhr.responseText)
  }

  const originalOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = new Proxy(originalOpen, {
    apply(target, xhr, args) {
      const url = toUrl(args[1])
      if (url && GRAPHQL_TWEET_ENDPOINT.test(url.pathname)) {
        xhr.addEventListener('load', () => emitXhrResponse(xhr))
      }
      return Reflect.apply(target, xhr, args)
    },
  })

  // X has moved most timeline/tweet requests from XHR to fetch. Clone the
  // response so inspecting it does not consume the stream the page is using.
  // Cache capture runs in parallel and never delays X's own response handling.
  const originalFetch = window.fetch
  window.fetch = new Proxy(originalFetch, {
    async apply(target, thisArg, args) {
      const response = await Reflect.apply(target, thisArg, args)
      const requestUrl = args[0] instanceof Request ? args[0].url : args[0]
      const url = toUrl(response.url || requestUrl)
      if (response.status === 200 && url && GRAPHQL_TWEET_ENDPOINT.test(url.pathname)) {
        response.clone().text()
          .then((body) => emitBody(url, response.status, body))
          .catch(() => {})
      }
      return response
    },
  })
})()
