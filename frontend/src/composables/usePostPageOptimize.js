// The post page's Media Optimizer: profile and preset controls, the
// review-first preview, and replacing or copying the post from it.
import { ref, computed, watch } from 'vue'
import api from '../api/client'
import {
  MEDIA_OPTIMIZE_PROFILES,
  MEDIA_OPTIMIZE_STORAGE_KEY,
  mediaOptimizeProfileLabel,
  mediaOptimizeProfileSettings,
  mediaOptimizeSavings,
} from '../utils/mediaOptimize'
import { formatFileSize } from './usePostPageFormat'

export function usePostPageOptimize({ post, router, loadPost }) {
  const BATCH_MEDIA_OPTIMIZE_KEY = MEDIA_OPTIMIZE_STORAGE_KEY
  const postMediaOptimizeDefaults = loadPostMediaOptimizeSettings()
  const postImageMaxDimension = ref(postMediaOptimizeDefaults.imageMaxDimension)
  const postImageQuality = ref(postMediaOptimizeDefaults.imageQuality)
  const postVideoMaxDimension = ref(postMediaOptimizeDefaults.videoMaxDimension)
  const postVideoBitrateKbps = ref(postMediaOptimizeDefaults.videoBitrateKbps)
  const postOptimizeProfile = ref(postMediaOptimizeDefaults.profile)
  const postImagePreset = ref('custom')
  const postVideoPreset = ref('custom')
  const postVideoBitratePreset = ref('custom')
  const optimizeBusy = ref(false)
  const optimizeStatus = ref('')
  const optimizeStatusKind = ref('success')
  const optimizePreview = ref(null)
  const optimizePreviewOpen = ref(false)
  const showOptimizeConfirm = ref(false)
  const postOptimizeApplyMode = ref('replace')
  const optimizeJob = ref(null)
  const optimizeJobProgress = computed(() => Math.max(0, Math.min(100, Number(optimizeJob.value?.progress || 0))))
  let optimizePollTimer = null
  const mediaOptimizeProfiles = MEDIA_OPTIMIZE_PROFILES

  const postCurrentMaxSide = computed(() => Math.max(Number(post.value?.width || 0), Number(post.value?.height || 0)))
  const postCurrentVideoBitrate = computed(() => estimatedVideoBitrateKbps(post.value))
  const postOptimizeExtension = computed(() => String(post.value?.extension || '').toLowerCase())
  const postOptimizeIsVideo = computed(() => ['.mp4', '.webm'].includes(postOptimizeExtension.value))
  const postOptimizeIsImage = computed(() => ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(postOptimizeExtension.value))
  const postImagePresetOptions = computed(() => mediaOptimizePresetOptions(postCurrentMaxSide.value, 'image'))
  const postVideoPresetOptions = computed(() => mediaOptimizePresetOptions(postCurrentMaxSide.value, 'video'))
  const postVideoBitratePresetOptions = computed(() => videoBitratePresetOptions(postCurrentVideoBitrate.value))
  const postOptimizeProfileName = computed(() => mediaOptimizeProfileLabel(postOptimizeProfile.value))
  const postOptimizeIsSocial = computed(() => postOptimizeProfile.value === 'social')
  const postOptimizeSourceResolution = computed(() => (
    post.value?.width && post.value?.height
      ? `${Number(post.value.width).toLocaleString()} × ${Number(post.value.height).toLocaleString()}`
      : 'Unknown dimensions'
  ))
  const postOptimizeTargetResolution = computed(() => {
    if (postOptimizeIsSocial.value) return 'Source dimensions within X limits'
    if (postOptimizeIsVideo.value) return `${Number(postVideoMaxDimension.value || 0).toLocaleString()}px maximum side`
    return `${Number(postImageMaxDimension.value || 0).toLocaleString()}px maximum side`
  })
  const postOptimizeTargetDetail = computed(() => {
    if (postOptimizeIsVideo.value) {
      if (postOptimizeIsSocial.value) return 'MP4 · H.264 High · AAC-LC · ≤40 FPS'
      return `Quality-first encode · ${Number(postVideoBitrateKbps.value || 0).toLocaleString()} kbps budget`
    }
    return `Image quality ${Number(postImageQuality.value || 0)} · metadata preserved where supported`
  })
  const optimizePreviewSavings = computed(() => mediaOptimizeSavings(
    optimizePreview.value?.oldSize,
    optimizePreview.value?.newSize,
  ))
  const optimizePreviewIsSocial = computed(() => (
    postOptimizeIsVideo.value &&
    (
      optimizePreview.value?.compatibility === 'social' ||
      (postOptimizeIsSocial.value && Boolean(optimizePreview.value))
    )
  ))
  const optimizePreviewCanApply = computed(() => (
    optimizePreview.value?.status === 'preview' &&
    Boolean(optimizePreview.value?.previewUrl) &&
    optimizePreviewSavings.value.after > 0 &&
    (
      optimizePreviewSavings.value.after < optimizePreviewSavings.value.before ||
      optimizePreviewIsSocial.value
    )
  ))
  const optimizePreviewAssessment = computed(() => {
    if (optimizePreviewIsSocial.value) {
      if (optimizePreview.value?.status !== 'preview') return 'Already X-compatible'
      if (optimizePreviewSavings.value.increaseBytes > 0) {
        return `X-compatible MP4 · ${formatFileSize(optimizePreviewSavings.value.increaseBytes)} larger`
      }
      if (optimizePreviewSavings.value.bytes > 0) {
        return `X-compatible MP4 · ${optimizePreviewSavings.value.percent}% smaller`
      }
      return 'X-compatible MP4 · same storage size'
    }
    return optimizePreviewCanApply.value
      ? `${optimizePreviewSavings.value.percent}% smaller`
      : 'Original is already more efficient'
  })
  const optimizePreviewGrowthExplanation = computed(() => {
    if (!optimizePreviewIsSocial.value || optimizePreviewSavings.value.increaseBytes <= 0) return ''
    const codec = String(optimizePreview.value?.sourceCodec || '').toLowerCase()
    const codecLabel = ({
      av1: 'AV1',
      vp9: 'VP9',
      hevc: 'HEVC',
      h265: 'HEVC',
    })[codec]
    if (codecLabel) {
      return `${codecLabel} stores video more efficiently than X’s H.264 target. This copy prioritizes visual quality, so some size growth is expected.`
    }
    return 'The X-compatible copy prioritizes visual quality. Review the storage increase before setting it.'
  })
  const optimizePreviewStorageLabel = computed(() => (
    optimizePreviewSavings.value.increaseBytes > 0 ? 'Size increase' : 'Space saved'
  ))
  const optimizePreviewStorageBytes = computed(() => (
    optimizePreviewSavings.value.increaseBytes || optimizePreviewSavings.value.bytes
  ))
  const optimizeConfirmStorageChange = computed(() => {
    if (optimizePreviewSavings.value.increaseBytes > 0) {
      return `+${optimizePreviewSavings.value.increasePercent}%`
    }
    return `-${optimizePreviewSavings.value.percent}%`
  })
  const optimizePreviewDimensionSummary = computed(() => {
    if (!optimizePreview.value) return ''
    const oldDimensions = optimizePreview.value.oldWidth && optimizePreview.value.oldHeight
      ? `${optimizePreview.value.oldWidth} × ${optimizePreview.value.oldHeight}`
      : 'source dimensions'
    const newDimensions = optimizePreview.value.width && optimizePreview.value.height
      ? `${optimizePreview.value.width} × ${optimizePreview.value.height}`
      : 'optimized dimensions'
    return `${oldDimensions} → ${newDimensions}`
  })
  const postOptimizeState = computed(() => {
    if (optimizeStatusKind.value === 'error') return 'error'
    if (optimizeBusy.value) return 'running'
    if (optimizePreview.value) return 'ready'
    return 'idle'
  })
  const postOptimizeStateLabel = computed(() => ({
    error: 'Needs attention',
    running: 'Processing',
    ready: optimizePreviewCanApply.value ? 'Ready to set' : 'Preview ready',
    idle: 'Quality-first',
  }[postOptimizeState.value]))
  const showOptimizeJobCard = computed(() => Boolean(
    optimizeJob.value && (optimizeBusy.value || optimizeStatusKind.value === 'error')
  ))
  const optimizePreviewMediaType = computed(() => {
    const extension = String(optimizePreview.value?.extension || postOptimizeExtension.value).toLowerCase()
    if (['.mp4', '.webm'].includes(extension)) return 'video'
    if (extension === '.gif') return 'gif'
    return 'image'
  })

  watch(
    [
      postImageMaxDimension,
      postImageQuality,
      postVideoMaxDimension,
      postVideoBitrateKbps,
      postOptimizeProfile,
      postImagePreset,
      postVideoPreset,
      postVideoBitratePreset,
    ],
    () => {
      optimizePreview.value = null
      optimizePreviewOpen.value = false
      savePostMediaOptimizeSettings()
    },
  )

  function loadPostMediaOptimizeSettings() {
    const fallback = {
      profile: 'balanced',
      imageMaxDimension: 1600,
      imageQuality: 88,
      videoMaxDimension: 1080,
      videoBitrateKbps: 6000,
    }
    try {
      const saved = JSON.parse(localStorage.getItem(BATCH_MEDIA_OPTIMIZE_KEY) || '{}')
      return {
        profile: ['fidelity', 'balanced', 'compact', 'social', 'custom'].includes(saved.profile) ? saved.profile : fallback.profile,
        imageMaxDimension: Number.isFinite(Number(saved.imageMaxDimension)) ? Number(saved.imageMaxDimension) : fallback.imageMaxDimension,
        imageQuality: Number.isFinite(Number(saved.imageQuality)) ? Number(saved.imageQuality) : fallback.imageQuality,
        videoMaxDimension: Number.isFinite(Number(saved.videoMaxDimension)) ? Number(saved.videoMaxDimension) : fallback.videoMaxDimension,
        videoBitrateKbps: Number.isFinite(Number(saved.videoBitrateKbps)) ? Number(saved.videoBitrateKbps) : fallback.videoBitrateKbps,
      }
    } catch {
      return fallback
    }
  }

  function mediaOptimizePresetOptions(currentMaxSide, label) {
    const current = Number(currentMaxSide || 0)
    const options = [{ value: 'custom', label: 'Custom' }]
    if (current >= 64) {
      options.unshift({ value: String(current), label: `Current ${label} max (${current}px)` })
    }
    for (const target of [2160, 1440, 1080, 720, 480]) {
      if (current && target >= current) continue
      options.splice(options.length - 1, 0, { value: String(target), label: `${target}px max side` })
    }
    return options
  }

  function videoBitratePresetOptions(currentKbps) {
    const current = Math.round(Number(currentKbps || 0))
    const options = [{ value: 'custom', label: 'Custom' }]
    if (current >= 64) {
      options.unshift({ value: String(current), label: `Current estimated bitrate (${current} kbps)` })
    }
    for (const target of [8000, 6000, 4000, 2500, 1500, 1000, 750, 500]) {
      if (current && target >= current) continue
      options.splice(options.length - 1, 0, { value: String(target), label: `${target} kbps` })
    }
    return options
  }

  function applyPresetValue(value, targetRef) {
    if (value === 'custom') return
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed >= 64) targetRef.value = Math.round(parsed)
  }

  function applyPostImagePreset() {
    applyPresetValue(postImagePreset.value, postImageMaxDimension)
    markPostOptimizeCustom()
  }

  function applyPostVideoPreset() {
    applyPresetValue(postVideoPreset.value, postVideoMaxDimension)
    markPostOptimizeCustom()
  }

  function applyPostVideoBitratePreset() {
    applyPresetValue(postVideoBitratePreset.value, postVideoBitrateKbps)
    markPostOptimizeCustom()
  }

  function applyPostOptimizeProfile(profileId) {
    const settings = mediaOptimizeProfileSettings(profileId, {
      imageMaxSide: postOptimizeIsImage.value ? postCurrentMaxSide.value : 0,
      videoMaxSide: postOptimizeIsVideo.value ? postCurrentMaxSide.value : 0,
      videoBitrateKbps: postCurrentVideoBitrate.value,
    })
    postOptimizeProfile.value = profileId
    postImagePreset.value = 'custom'
    postVideoPreset.value = 'custom'
    postVideoBitratePreset.value = 'custom'
    postImageMaxDimension.value = settings.imageMaxDimension
    postImageQuality.value = settings.imageQuality
    postVideoMaxDimension.value = settings.videoMaxDimension
    postVideoBitrateKbps.value = settings.videoBitrateKbps
  }

  function markPostOptimizeCustom() {
    postOptimizeProfile.value = 'custom'
  }

  function savePostMediaOptimizeSettings() {
    try {
      localStorage.setItem(BATCH_MEDIA_OPTIMIZE_KEY, JSON.stringify({
        profile: postOptimizeProfile.value,
        imageMaxDimension: postImageMaxDimension.value,
        imageQuality: postImageQuality.value,
        videoMaxDimension: postVideoMaxDimension.value,
        videoBitrateKbps: postVideoBitrateKbps.value,
      }))
    } catch {
      // localStorage unavailable
    }
  }

  function currentPostOptimizePayload() {
    const imageMax = Number(postImageMaxDimension.value || 0)
    const imageQuality = Number(postImageQuality.value || 85)
    const videoMax = Number(postVideoMaxDimension.value || 0)
    const videoBitrate = Number(postVideoBitrateKbps.value || 0)
    return {
      postIds: [post.value.id],
      imageMaxDimension: imageMax >= 64 ? Math.round(imageMax) : null,
      imageQuality: Math.max(1, Math.min(100, Math.round(imageQuality || 85))),
      videoMaxDimension: videoMax >= 64 ? Math.round(videoMax) : null,
      videoBitrateKbps: videoBitrate >= 64 ? Math.round(videoBitrate) : null,
      socialCompatible: postOptimizeIsSocial.value,
    }
  }

  function estimatedVideoBitrateKbps(value) {
    const duration = Number(value?.duration || 0)
    const bytes = Number(value?.fileSize || 0)
    return duration > 0 && bytes > 0 ? Math.round((bytes * 8) / duration / 1000) : 0
  }

  async function optimizeCurrentPost() {
    if (!post.value?.id || optimizeBusy.value) return
    const payload = {
      ...currentPostOptimizePayload(),
      applyMode: postOptimizeApplyMode.value,
      previewIds: {
        [post.value.id]: optimizePreview.value?.previewId,
      },
    }
    if (!payload.socialCompatible && !payload.imageMaxDimension && !payload.videoMaxDimension && !payload.videoBitrateKbps) {
      optimizeStatus.value = 'Set an image size, video size, or video bitrate first.'
      optimizeStatusKind.value = 'error'
      return
    }
    if (!optimizePreviewCanApply.value) {
      optimizeStatus.value = 'Preview must produce a valid reviewed output before Set can replace the original.'
      optimizeStatusKind.value = 'error'
      return
    }
    optimizeBusy.value = true
    optimizeStatus.value = postOptimizeApplyMode.value === 'create'
      ? 'Creating a new post from the exact reviewed preview...'
      : 'Applying the exact reviewed preview...'
    optimizeStatusKind.value = 'success'
    try {
      const result = await runOptimizeJob(payload)
      optimizePreview.value = null
      optimizePreviewOpen.value = false
      showOptimizeConfirm.value = false
      const item = result.results?.[0]
      if (result.optimized) {
        if (item?.status === 'created' && item?.newPostId) {
          await router.push({ name: 'post', params: { id: item.newPostId } })
          return
        }
        await loadPost()
        optimizeStatus.value = item?.compatibility === 'social'
          ? `Set X-compatible MP4 (${formatFileSize(item.newSize)}).`
          : item?.oldSize && item?.newSize
            ? `Optimized from ${formatFileSize(item.oldSize)} to ${formatFileSize(item.newSize)}.`
            : 'Post optimized.'
        optimizeStatusKind.value = 'success'
      } else if (result.skipped) {
        optimizeStatus.value = item?.message || 'Post was already within the requested limits.'
        optimizeStatusKind.value = 'success'
      } else {
        optimizeStatus.value = item?.message || 'Optimization failed.'
        optimizeStatusKind.value = 'error'
      }
    } catch (e) {
      optimizeStatus.value = e.message || 'Optimization failed.'
      optimizeStatusKind.value = 'error'
    } finally {
      optimizeBusy.value = false
    }
  }

  async function confirmOptimizeCurrentPost() {
    showOptimizeConfirm.value = false
    await optimizeCurrentPost()
  }

  function sourcePreviewFallback(item = null) {
    return {
      ...(item || {}),
      postId: post.value.id,
      status: 'source',
      previewUrl: post.value.contentUrl,
      extension: post.value.extension,
      oldSize: Number(post.value.fileSize || 0),
      newSize: Number(post.value.fileSize || 0),
      oldWidth: post.value.width,
      oldHeight: post.value.height,
      width: post.value.width,
      height: post.value.height,
    }
  }

  async function previewCurrentPostOptimize() {
    if (!post.value?.id || optimizeBusy.value) return
    const payload = { ...currentPostOptimizePayload(), preview: true }
    if (!payload.socialCompatible && !payload.imageMaxDimension && !payload.videoMaxDimension && !payload.videoBitrateKbps) {
      optimizeStatus.value = 'Set an image size, video size, or video bitrate first.'
      optimizeStatusKind.value = 'error'
      return
    }
    optimizeBusy.value = true
    optimizeStatus.value = 'Starting preview...'
    optimizeStatusKind.value = 'success'
    optimizePreview.value = null
    showOptimizeConfirm.value = false
    try {
      const result = await runOptimizeJob(payload)
      const item = result.results?.[0]
      if (result.optimized && item) {
        optimizePreview.value = item
        optimizePreviewOpen.value = true
        const dimensions = item.width && item.height
          ? `, ${item.oldWidth || '?'} x ${item.oldHeight || '?'} -> ${item.width} x ${item.height}`
          : ''
        optimizeStatus.value = `Preview: ${formatFileSize(item.oldSize)} -> ${formatFileSize(item.newSize)}${dimensions}.`
        optimizeStatusKind.value = 'success'
      } else if (result.skipped) {
        optimizePreview.value = sourcePreviewFallback(item)
        optimizePreviewOpen.value = true
        optimizeStatus.value = `${item?.message || 'No smaller quality-preserving output was produced.'} Showing the current file; Preview will reopen it without processing again.`
        optimizeStatusKind.value = 'success'
      } else {
        optimizeStatus.value = item?.message || 'Preview failed.'
        optimizeStatusKind.value = 'error'
      }
    } catch (e) {
      optimizeStatus.value = e.message || 'Preview failed.'
      optimizeStatusKind.value = 'error'
    } finally {
      optimizeBusy.value = false
      optimizeJob.value = null
    }
  }

  function openOrCreateOptimizePreview() {
    if (optimizePreview.value?.previewUrl) {
      optimizePreviewOpen.value = true
      return
    }
    previewCurrentPostOptimize()
  }

  function closeOptimizePreview() {
    optimizePreviewOpen.value = false
  }

  function requestSetOptimizePreview() {
    if (!optimizePreviewCanApply.value) {
      optimizeStatus.value = 'Set becomes available when Preview produces a smaller reviewed output.'
      optimizeStatusKind.value = 'error'
      return
    }
    showOptimizeConfirm.value = true
  }

  function stopOptimizePolling() {
    if (optimizePollTimer) {
      clearInterval(optimizePollTimer)
      optimizePollTimer = null
    }
  }

  function runOptimizeJob(payload) {
    stopOptimizePolling()
    return new Promise(async (resolve, reject) => {
      try {
        optimizeJob.value = await api.createOptimizeJob(payload)
        optimizeStatus.value = optimizeJob.value.message || 'Queued media optimization...'
        optimizePollTimer = setInterval(async () => {
          try {
            const job = await api.getOptimizeJob(optimizeJob.value.id)
            optimizeJob.value = job
            optimizeStatus.value = job.message || optimizeStatus.value
            if (job.status === 'completed') {
              stopOptimizePolling()
              resolve(job)
            } else if (job.status === 'failed') {
              stopOptimizePolling()
              reject(new Error(job.error || job.message || 'Optimization failed'))
            }
          } catch (error) {
            stopOptimizePolling()
            reject(error)
          }
        }, 750)
      } catch (error) {
        reject(error)
      }
    })
  }
  return {
    mediaOptimizeProfiles,
    postImageMaxDimension,
    postImageQuality,
    postVideoMaxDimension,
    postVideoBitrateKbps,
    postOptimizeProfile,
    postImagePreset,
    postVideoPreset,
    postVideoBitratePreset,
    optimizeBusy,
    optimizeStatus,
    optimizeStatusKind,
    optimizePreview,
    optimizePreviewOpen,
    showOptimizeConfirm,
    postOptimizeApplyMode,
    optimizeJob,
    optimizeJobProgress,
    postCurrentMaxSide,
    postCurrentVideoBitrate,
    postOptimizeExtension,
    postOptimizeIsVideo,
    postOptimizeIsImage,
    postImagePresetOptions,
    postVideoPresetOptions,
    postVideoBitratePresetOptions,
    postOptimizeProfileName,
    postOptimizeIsSocial,
    postOptimizeSourceResolution,
    postOptimizeTargetResolution,
    postOptimizeTargetDetail,
    optimizePreviewSavings,
    optimizePreviewIsSocial,
    optimizePreviewCanApply,
    optimizePreviewAssessment,
    optimizePreviewGrowthExplanation,
    optimizePreviewStorageLabel,
    optimizePreviewStorageBytes,
    optimizeConfirmStorageChange,
    optimizePreviewDimensionSummary,
    postOptimizeState,
    postOptimizeStateLabel,
    showOptimizeJobCard,
    optimizePreviewMediaType,
    applyPostImagePreset,
    applyPostVideoPreset,
    applyPostVideoBitratePreset,
    applyPostOptimizeProfile,
    markPostOptimizeCustom,
    optimizeCurrentPost,
    confirmOptimizeCurrentPost,
    previewCurrentPostOptimize,
    openOrCreateOptimizePreview,
    closeOptimizePreview,
    requestSetOptimizePreview,
    stopOptimizePolling,
  }
}
