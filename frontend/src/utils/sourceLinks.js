export function pixivArtworkIdFromPost(post) {
  const tags = Array.isArray(post?.tags) ? post.tags : []
  for (const entry of tags) {
    const name = typeof entry === 'string' ? entry : entry?.name
    const match = String(name || '').match(/^pixiv_(\d+)$/)
    if (match) return match[1]
  }
  return ''
}

export function pixivArtworkUrlFromPost(post) {
  const artworkId = pixivArtworkIdFromPost(post)
  return artworkId ? `https://www.pixiv.net/en/artworks/${artworkId}` : ''
}
