// Getting media into the upload queue from outside the file picker:
// document paste, the clipboard button, and remote URLs (direct media,
// yt-dlp video pages, fediverse posts, clip-editor video links).
import { ref, reactive } from 'vue'
import api from '../api/client'

function isClipEditorUrl(text) {
  try {
    const url = new URL(text)
    if (!['http:', 'https:'].includes(url.protocol)) return false
    const host = url.hostname.toLowerCase()
    return host === 'youtu.be'
      || host === 'youtube.com'
      || host.endsWith('.youtube.com')
      || host === 'rumble.com'
      || host.endsWith('.rumble.com')
      || host === 'odysee.com'
      || host.endsWith('.odysee.com')
      || host === 'lbry.tv'
      || host.endsWith('.lbry.tv')
  } catch {
    return false
  }
}

export function isVideoUrl(text) {
  // Check if text looks like a URL to a video platform (for yt-dlp)
  try {
    const url = new URL(text)
    if (!['http:', 'https:'].includes(url.protocol)) return false

    // Video platform domains that yt-dlp handles well
    const videoPlatforms = [
      'twitter.com', 'x.com',
      'youtube.com', 'youtu.be', 'www.youtube.com',
      'rumble.com', 'www.rumble.com',
      'odysee.com', 'www.odysee.com', 'lbry.tv',
      'tiktok.com', 'www.tiktok.com',
      'instagram.com', 'www.instagram.com',
      'reddit.com', 'www.reddit.com', 'old.reddit.com',
      'vimeo.com',
      'twitch.tv', 'clips.twitch.tv',
      'dailymotion.com',
      'streamable.com',
      'v.redd.it',
      'redgifs.com', 'www.redgifs.com',
    ]

    // Check if it's a video platform URL
    if (videoPlatforms.some(domain => url.host === domain || url.host.endsWith('.' + domain))) {
      // For instagram, only match reels and posts with video
      if (url.host.includes('instagram.com')) {
        return url.pathname.includes('/reel/') || url.pathname.includes('/p/')
      }
      // For reddit, match video posts
      if (url.host.includes('reddit.com') || url.host === 'v.redd.it') {
        return true
      }
      return true
    }

    return false
  } catch {
    return false
  }
}

export function isFediverseUrl(text) {
  try {
    const url = new URL(text)
    if (!['http:', 'https:'].includes(url.protocol)) return false
    const p = url.pathname
    // Misskey-style: /notes/{id}
    if (/\/notes\/[a-zA-Z0-9]+/.test(p)) return true
    // Pleroma-style: /notice/{id}
    if (/\/notice\/[a-zA-Z0-9]+/.test(p)) return true
    // Mastodon/Pleroma-style: /@username/{numeric_id}
    if (/\/@[^/]+\/\d+/.test(p)) return true
    return false
  } catch {
    return false
  }
}

export function isImageUrl(text) {
  // Check if text looks like a URL to an image/video file (direct links)
  try {
    const url = new URL(text)
    if (!['http:', 'https:'].includes(url.protocol)) return false

    // Check common image/video extensions (direct file links)
    const ext = url.pathname.split('.').pop()?.toLowerCase()
    const mediaExts = ['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'webm', 'mp4']
    if (mediaExts.includes(ext)) return true

    // Check common image hosting domains (direct image links)
    const imageHosts = [
      'i.imgur.com', 'imgur.com',
      'i.redd.it', 'preview.redd.it',
      'pbs.twimg.com', 'media.tumblr.com',
      'cdn.discordapp.com', 'media.discordapp.net',
      'i.pinimg.com', 'i.pximg.net',
      'gelbooru.com', 'safebooru.org', 'danbooru.donmai.us',
    ]
    if (imageHosts.some(host => url.host.includes(host))) return true

    return false
  } catch {
    return false
  }
}
export function useUploadSources({ queue, remoteClipEditor }) {
  const { uploads, addFiles, createQueueUpload, nextUploadId, waitForReady, showToast } = queue
  const fetchingUrl = ref(false)
  const fetchingVideo = ref(false)
  const fetchingFediverse = ref(false)

  async function handlePaste(e) {
    // Don't intercept paste events in input fields
    const activeElement = document.activeElement
    if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')) {
      return
    }

    const clipboardData = e.clipboardData
    if (!clipboardData) return

    // Check for pasted files/images
    const files = Array.from(clipboardData.files)
    if (files.length > 0) {
      e.preventDefault()
      addFiles(files)
      return
    }

    // Check for image items (screenshots, copied images)
    for (const item of clipboardData.items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const blob = item.getAsFile()
        if (blob) {
          // Create a File with a generated name
          const ext = item.type.split('/')[1] || 'png'
          const filename = `pasted-image-${Date.now()}.${ext}`
          const file = new File([blob], filename, { type: item.type })
          addFiles([file])
        }
        return
      }
    }

    // Check for pasted URL text
    const text = clipboardData.getData('text/plain')?.trim()
    if (text && (isVideoUrl(text) || isFediverseUrl(text) || isImageUrl(text))) {
      e.preventDefault()
      await processPastedText(text)
    }
  }

  // Route a pasted/clipboard string to the right fetcher. Returns true if handled.
  async function processPastedText(text) {
    if (isClipEditorUrl(text)) {
      remoteClipEditor.value?.setUrl(text)
      showToast('Video link added to the clip editor.')
      return true
    } else if (isVideoUrl(text)) {
      await fetchFromYtdlp(text)
      return true
    } else if (isFediverseUrl(text)) {
      await fetchFromFediverse(text)
      return true
    } else if (isImageUrl(text)) {
      await fetchFromUrl(text)
      return true
    }
    return false
  }

  // Read the clipboard on demand (button press). Needed on mobile where the
  // document 'paste' event never fires, so video links can't otherwise be added.
  async function pasteFromClipboard() {
    if (!navigator.clipboard) {
      showToast('Clipboard access not available in this browser, nyaa~')
      return
    }

    try {
      // Try reading image data first (screenshots, copied images)
      if (navigator.clipboard.read) {
        try {
          const items = await navigator.clipboard.read()
          for (const item of items) {
            const imageType = item.types.find(t => t.startsWith('image/'))
            if (imageType) {
              const blob = await item.getType(imageType)
              const ext = imageType.split('/')[1] || 'png'
              const file = new File([blob], `pasted-image-${Date.now()}.${ext}`, { type: imageType })
              addFiles([file])
              return
            }
          }
        } catch {
          // Image read not permitted/available — fall through to text
        }
      }

      const text = (await navigator.clipboard.readText())?.trim()
      if (!text) {
        showToast('Clipboard is empty, nyaa~')
        return
      }
      const handled = await processPastedText(text)
      if (!handled) {
        showToast("That doesn't look like a supported link, nyaa~")
      }
    } catch (e) {
      showToast('Could not read clipboard: ' + e.message)
    }
  }

  async function fetchFromUrl(url) {
    fetchingUrl.value = true
    showToast('Fetching image from URL...')
    const upload = createQueueUpload({ name: new URL(url).pathname.split('/').pop() || 'remote-media', size: 0, type: 'application/octet-stream' })
    uploads.value.push(upload)
    try {
      upload.job = await api.createUploadJob({ kind: 'direct_url', sourceUrl: url }, crypto.randomUUID())
      upload.uploading = true
      upload.job = await waitForReady(upload, upload.job.id)
      const artifact = upload.job.artifacts.find(item => item.role === 'source')
      if (!artifact) throw new Error('Remote download completed without an artifact.')
      upload.file = { name: artifact.filename, size: artifact.fileSize, type: artifact.mimeType }
      upload.preview = artifact.contentUrl
      upload.artifactId = artifact.id
      upload.source = upload.job.source?.canonicalUrl || url
      showToast('Image fetched successfully!')
    } catch (e) {
      upload.error = e.message
      showToast('Failed to fetch media: ' + e.message)
    } finally {
      upload.uploading = false
      fetchingUrl.value = false
    }
  }

  async function fetchFromYtdlp(url) {
    fetchingVideo.value = true
    showToast('Downloading video...')

    try {
      const result = await api.uploadFromYtdlp(url)

      // Create a pseudo-upload entry with video info
      const upload = reactive({
        id: nextUploadId(),
        file: { name: result.filename, size: 0, type: 'video/mp4' },
        tags: [],
        safety: 'safe',
        preview: result.thumbnail || null, // Use yt-dlp thumbnail
        previewObjectUrl: false,
        uploading: false,
        completed: false,
        error: null,
        aiTagging: false,
        aiProfile: '',
        aiStatus: '',
        aiError: false,
        aiPreviewed: false,
        token: result.token, // Pre-uploaded token
        videoInfo: {
          title: result.title,
          duration: result.duration,
          uploader: result.uploader,
        },
      })

      uploads.value.push(upload)

      // Show success with video title
      const title = result.title?.length > 50 ? result.title.slice(0, 50) + '...' : result.title
      showToast(`Video downloaded: ${title}`)
    } catch (e) {
      showToast('Failed to download video: ' + e.message)
    } finally {
      fetchingVideo.value = false
    }
  }

  async function fetchFromFediverse(url) {
    fetchingFediverse.value = true
    showToast('Fetching from fediverse post...')
    const placeholder = createQueueUpload({ name: 'Fediverse import', size: 0, type: 'application/octet-stream' })
    uploads.value.push(placeholder)
    try {
      placeholder.job = await api.createUploadJob({ kind: 'fediverse', sourceUrl: url }, crypto.randomUUID())
      placeholder.uploading = true
      const ready = await waitForReady(placeholder, placeholder.job.id)
      const placeholderIndex = uploads.value.findIndex(item => item.id === placeholder.id)
      if (placeholderIndex !== -1) uploads.value.splice(placeholderIndex, 1)
      const artifacts = ready.artifacts.filter(item => item.role === 'source')
      for (const artifact of artifacts) {
        const upload = createQueueUpload({ name: artifact.filename, size: artifact.fileSize, type: artifact.mimeType })
        upload.tags = [...(ready.source?.tags || [])]
        upload.preview = artifact.contentUrl
        upload.artifactId = artifact.id
        upload.source = ready.source?.canonicalUrl || url
        upload.job = ready
        uploads.value.push(upload)
      }
      const count = artifacts.length
      showToast(`Fetched ${count} attachment${count !== 1 ? 's' : ''} from ${ready.source?.platform || 'Fediverse'} post!`)
    } catch (e) {
      placeholder.error = e.message
      showToast('Failed to fetch fediverse post: ' + e.message)
    } finally {
      placeholder.uploading = false
      fetchingFediverse.value = false
    }
  }
  return {
    fetchingUrl,
    fetchingVideo,
    fetchingFediverse,
    handlePaste,
    processPastedText,
    pasteFromClipboard,
    fetchFromUrl,
    fetchFromYtdlp,
    fetchFromFediverse,
  }
}
