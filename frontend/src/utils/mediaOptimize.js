export const MEDIA_OPTIMIZE_STORAGE_KEY = 'nekobooru.mediaOptimize.v5'

export const MEDIA_OPTIMIZE_PROFILES = [
  {
    id: 'fidelity',
    label: 'Fidelity',
    badge: 'Best quality',
    description: 'Retains source dimensions and gives motion-heavy video a generous bitrate budget.',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    badge: 'Recommended',
    description: 'High visual quality with practical storage savings for everyday library use.',
  },
  {
    id: 'compact',
    label: 'Compact',
    badge: 'Maximum savings',
    description: 'Smaller delivery files for previews, mobile access, and constrained storage.',
  },
  {
    id: 'social',
    label: 'Social / X',
    badge: 'Compatible MP4',
    description: 'Keeps source dimensions when accepted and creates an H.264/AAC MP4 for social uploads.',
  },
]

function cappedSide(current, cap, fallback) {
  const parsed = Math.round(Number(current || 0))
  if (parsed >= 64) return Math.min(parsed, cap)
  return fallback
}

function sourceRelativeVideoBudget(currentBitrate, ratio, fallback) {
  const parsed = Math.round(Number(currentBitrate || 0))
  if (parsed < 256) return fallback
  const audioAllowance = parsed >= 1200 ? 128 : 96
  return Math.max(350, Math.round((parsed * ratio) - audioAllowance))
}

export function mediaOptimizeProfileSettings(
  profileId,
  {
    imageMaxSide = 0,
    videoMaxSide = 0,
    videoBitrateKbps = 0,
  } = {},
) {
  const currentBitrate = Math.round(Number(videoBitrateKbps || 0))

  if (profileId === 'social') {
    return {
      imageMaxDimension: cappedSide(imageMaxSide, 8192, 2160),
      imageQuality: 100,
      videoMaxDimension: cappedSide(videoMaxSide, 1920, 1920),
      videoBitrateKbps: currentBitrate >= 256 ? currentBitrate : 5000,
    }
  }

  if (profileId === 'fidelity') {
    return {
      imageMaxDimension: cappedSide(imageMaxSide, 8192, 2160),
      imageQuality: 94,
      videoMaxDimension: cappedSide(videoMaxSide, 8192, 2160),
      videoBitrateKbps: sourceRelativeVideoBudget(currentBitrate, 0.92, 10000),
    }
  }

  if (profileId === 'compact') {
    return {
      imageMaxDimension: cappedSide(imageMaxSide, 1200, 1200),
      imageQuality: 82,
      videoMaxDimension: cappedSide(videoMaxSide, 720, 720),
      videoBitrateKbps: sourceRelativeVideoBudget(currentBitrate, 0.62, 3000),
    }
  }

  return {
    imageMaxDimension: cappedSide(imageMaxSide, 1600, 1600),
    imageQuality: 88,
    videoMaxDimension: cappedSide(videoMaxSide, 1080, 1080),
    videoBitrateKbps: sourceRelativeVideoBudget(currentBitrate, 0.78, 6000),
  }
}

export function mediaOptimizeSavings(oldSize, newSize) {
  const before = Number(oldSize || 0)
  const after = Number(newSize || 0)
  const bytes = Math.max(0, before - after)
  const increaseBytes = Math.max(0, after - before)
  const delta = after - before
  const percent = before > 0 ? Math.max(0, Math.round((bytes / before) * 100)) : 0
  const increasePercent = before > 0 ? Math.max(0, Math.round((increaseBytes / before) * 100)) : 0
  return { before, after, bytes, increaseBytes, delta, percent, increasePercent }
}

export function mediaOptimizeProfileLabel(profileId) {
  if (profileId === 'custom') return 'Custom controls'
  return MEDIA_OPTIMIZE_PROFILES.find((profile) => profile.id === profileId)?.label || 'Balanced'
}
