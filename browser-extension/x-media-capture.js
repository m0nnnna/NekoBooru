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

  function emitResponse(xhr) {
    if (xhr.status !== 200 || typeof xhr.responseText !== 'string' || !xhr.responseText) return
    const url = toUrl(xhr.responseURL)
    if (!url || !GRAPHQL_TWEET_ENDPOINT.test(url.pathname)) return
    document.dispatchEvent(new CustomEvent(EVENT_NAME, {
      detail: {
        path: url.pathname,
        body: xhr.responseText,
      },
    }))
  }

  const originalOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = new Proxy(originalOpen, {
    apply(target, xhr, args) {
      const url = toUrl(args[1])
      if (url && GRAPHQL_TWEET_ENDPOINT.test(url.pathname)) {
        xhr.addEventListener('load', () => emitResponse(xhr))
      }
      return Reflect.apply(target, xhr, args)
    },
  })
})()
