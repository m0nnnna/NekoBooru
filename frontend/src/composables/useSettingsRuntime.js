// Runtime & packaging status, the optional AI runtime installer, app
// update checks, and restarting the packaged app.
import { computed, onUnmounted, ref } from 'vue'
import api from '../api/client'

export function useSettingsRuntime({ autoTag }) {
  const { refreshAutoTagStatus } = autoTag

  const runtimeStatus = ref({})
  const updateStatus = ref({})
  const updateSettings = ref({
    owner: 'm0nnnna',
    repo: 'NekoBooru',
    channel: 'stable',
    autoCheck: true,
    autoDownload: false,
    includePrereleases: false,
  })
  const updateBusy = ref(false)
  const updateMessage = ref({
    show: false,
    success: false,
    message: '',
  })
  const aiRuntimeProfiles = ref([])
  const selectedAiRuntimeProfile = ref('auto')
  const aiRuntimeJob = ref(null)
  const aiRuntimeBusy = ref(false)
  const aiRuntimeMessage = ref({
    show: false,
    success: false,
    message: '',
  })
  const restartBusy = ref(false)
  const restartMessage = ref({
    show: false,
    success: true,
    message: '',
  })
  const aiSetupTarget = ref('cuda')
  const aiSetupCopied = ref(false)
  const recheckingRuntime = ref(false)
  let aiRuntimePollTimer = null

  const runtimeAiSummary = computed(() => {
    const ai = runtimeStatus.value.ai || {}
    if (ai.runtimeInstalled) return ai.profile || 'installed'
    const receiptError = ai.receipt?.error
    return receiptError ? `receipt error: ${receiptError}` : 'Install from Auto Tagging setup'
  })

  const runtimeToolSummary = computed(() => {
    const tools = runtimeStatus.value.tools || {}
    const ready = ['ffmpeg', 'ffprobe', 'ytdlp'].filter((key) => tools[key]?.available).length
    return `${ready}/3 ready`
  })

  const aiRuntimeProfileRows = computed(() => aiRuntimeProfiles.value.length
    ? aiRuntimeProfiles.value
    : [
        { id: 'auto', label: 'Auto-detect NVIDIA GPU', description: 'Pick GPU, legacy GPU, or CPU automatically.', downloadSize: '~3-8 GB', vram: 'Depends on models' },
        { id: 'cpu', label: 'Local CPU AI', description: 'No CUDA required. Slower, but simple.', downloadSize: '~3-5 GB', vram: '0 GB' },
        { id: 'gpu-cu128', label: 'Local NVIDIA AI', description: 'CUDA 12.8 for newer NVIDIA GPUs.', downloadSize: '~6-8 GB', vram: 'Model dependent' },
        { id: 'gpu-cu126-legacy', label: 'Local legacy NVIDIA AI', description: 'CUDA 12.6 for GTX 10-series/Pascal.', downloadSize: '~6-8 GB', vram: 'Model dependent' },
        { id: 'remote', label: 'Remote/server AI', description: 'Use another GPU machine instead of local CUDA wheels.', downloadSize: '0 GB on this client', vram: 'Remote worker' },
      ])

  const aiRuntimeInstallProgress = computed(() => {
    if (!aiRuntimeJob.value) return 0
    return Math.max(0, Math.min(100, Number(aiRuntimeJob.value.progress || 0)))
  })

  const aiSetupCommand = computed(() =>
    ({
      cpu: 'nekobooru --install-ai --profile cpu',
      'gpu-cu128': 'nekobooru --install-ai --profile gpu-cu128',
      'gpu-cu126-legacy': 'nekobooru --install-ai --profile gpu-cu126-legacy',
      remote: 'Configure remote/server AI worker below; no local CUDA wheels are installed.',
      auto: 'nekobooru --install-ai --profile auto',
    }[selectedAiRuntimeProfile.value] || 'nekobooru --install-ai --profile auto')
  )

  async function loadRuntimeStatus() {
    try {
      const [status, profiles] = await Promise.all([
        api.getRuntimeStatus(),
        api.getAiRuntimeProfiles(),
      ])
      runtimeStatus.value = status || {}
      aiRuntimeProfiles.value = profiles.profiles || []
      aiRuntimeJob.value = profiles.installJob || aiRuntimeJob.value
      aiRuntimeBusy.value = ['queued', 'running', 'cancelling'].includes(aiRuntimeJob.value?.status)
      if (aiRuntimeBusy.value) startAiRuntimePolling()
    } catch (e) {
      aiRuntimeMessage.value = {
        show: true,
        success: false,
        message: 'Failed to load runtime status: ' + e.message,
      }
    }
  }

  async function restartNekoBooru() {
    if (restartBusy.value || !runtimeStatus.value.restart?.available) return
    restartBusy.value = true
    restartMessage.value = {
      show: true,
      success: true,
      message: 'Restart requested. Waiting for NekoBooru to come back online...',
    }
    try {
      await api.restartApp()
      await waitForBackendAfterRestart()
      restartMessage.value = {
        show: true,
        success: true,
        message: 'NekoBooru restarted successfully.',
      }
      // The restart is complete once the health check succeeds. Runtime/model
      // diagnostics can be slow (or wait on a model process), so refresh them in
      // the background instead of leaving the Restart button permanently busy.
      restartBusy.value = false
      void Promise.allSettled([loadRuntimeStatus(), refreshAutoTagStatus()])
    } catch (e) {
      restartMessage.value = {
        show: true,
        success: false,
        message: 'Restart failed: ' + e.message,
      }
    } finally {
      restartBusy.value = false
    }
  }

  async function waitForBackendAfterRestart() {
    const base = apiBaseUrl()
    let sawOffline = false
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await delay(750)
      try {
        const response = await fetch(`${base}/health`, { cache: 'no-store' })
        if (response.ok) {
          const body = await response.json().catch(() => ({}))
          if (body.status === 'ok' && (sawOffline || attempt > 4)) return
        }
      } catch {
        sawOffline = true
      }
    }
    throw new Error('backend did not respond after restart')
  }

  function apiBaseUrl() {
    const configured = import.meta.env.VITE_API_URL
    if (configured) return configured.replace(/\/$/, '')
    return `${window.location.protocol}//${window.location.host}/api`
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async function startAiRuntimeInstall() {
    aiRuntimeBusy.value = true
    aiRuntimeMessage.value = {
      show: true,
      success: true,
      message: 'Starting AI runtime install. Large CUDA wheels can take a while.',
    }
    try {
      aiRuntimeJob.value = await api.installAiRuntime(selectedAiRuntimeProfile.value)
      if (aiRuntimeJob.value?.status === 'completed') {
        aiRuntimeBusy.value = false
        aiRuntimeMessage.value = {
          show: true,
          success: true,
          message: aiRuntimeJob.value.message || 'AI runtime is already installed.',
        }
        await Promise.all([loadRuntimeStatus(), refreshAutoTagStatus()])
        return
      }
      startAiRuntimePolling()
    } catch (e) {
      aiRuntimeBusy.value = false
      aiRuntimeMessage.value = {
        show: true,
        success: false,
        message: 'Failed to start AI runtime install: ' + e.message,
      }
    }
  }

  async function cancelAiRuntimeInstall() {
    try {
      aiRuntimeJob.value = await api.cancelAiRuntimeInstall()
      aiRuntimeMessage.value = {
        show: true,
        success: false,
        message: 'AI runtime install cancellation requested.',
      }
    } catch (e) {
      aiRuntimeMessage.value = {
        show: true,
        success: false,
        message: 'Failed to cancel AI runtime install: ' + e.message,
      }
    }
  }

  function startAiRuntimePolling() {
    if (aiRuntimePollTimer) clearInterval(aiRuntimePollTimer)
    aiRuntimePollTimer = setInterval(async () => {
      try {
        aiRuntimeJob.value = await api.getAiRuntimeInstallJob()
        aiRuntimeBusy.value = ['queued', 'running', 'cancelling'].includes(aiRuntimeJob.value?.status)
        if (!aiRuntimeBusy.value) {
          clearInterval(aiRuntimePollTimer)
          aiRuntimePollTimer = null
          const ok = aiRuntimeJob.value?.status === 'completed'
          aiRuntimeMessage.value = {
            show: true,
            success: ok,
            message: ok
              ? 'AI runtime install completed.'
              : `AI runtime install failed: ${aiRuntimeJob.value?.error || 'open installer output for details'}`,
          }
          await Promise.all([loadRuntimeStatus(), refreshAutoTagStatus()])
        }
      } catch (e) {
        clearInterval(aiRuntimePollTimer)
        aiRuntimePollTimer = null
        aiRuntimeBusy.value = false
        aiRuntimeMessage.value = {
          show: true,
          success: false,
          message: 'Failed to poll AI runtime install: ' + e.message,
        }
      }
    }, 1500)
  }

  function applyUpdateStatus(result) {
    updateStatus.value = result || {}
    const raw = updateStatus.value.settings || {}
    updateSettings.value = {
      owner: raw.owner || 'm0nnnna',
      repo: raw.repo || 'NekoBooru',
      channel: raw.channel || 'stable',
      autoCheck: raw.autoCheck !== false,
      autoDownload: raw.autoDownload === true,
      includePrereleases: raw.includePrereleases === true,
    }
  }

  async function loadUpdateStatus(auto = false) {
    try {
      applyUpdateStatus(await api.getUpdateStatus(auto))
    } catch (e) {
      updateMessage.value = {
        show: true,
        success: false,
        message: 'Failed to load update status: ' + e.message,
      }
    }
  }

  async function saveUpdateSettings() {
    updateBusy.value = true
    updateMessage.value.show = false
    try {
      applyUpdateStatus(await api.updateUpdateSettings({
        ...updateSettings.value,
        includePrereleases: updateSettings.value.channel === 'prerelease',
      }))
      updateMessage.value = {
        show: true,
        success: true,
        message: 'Update settings saved.',
      }
    } catch (e) {
      updateMessage.value = {
        show: true,
        success: false,
        message: 'Failed to save update settings: ' + e.message,
      }
    } finally {
      updateBusy.value = false
    }
  }

  async function checkForUpdates() {
    updateBusy.value = true
    updateMessage.value = {
      show: true,
      success: true,
      message: 'Checking GitHub Releases...',
    }
    try {
      applyUpdateStatus(await api.checkForUpdates())
      const check = updateStatus.value.lastCheck || {}
      updateMessage.value = {
        show: true,
        success: !check.error,
        message: check.message || 'Update check completed.',
      }
    } catch (e) {
      updateMessage.value = {
        show: true,
        success: false,
        message: 'Failed to check for updates: ' + e.message,
      }
    } finally {
      updateBusy.value = false
    }
  }

  async function recheckAiRuntime() {
    recheckingRuntime.value = true
    try {
      await refreshAutoTagStatus()
    } finally {
      recheckingRuntime.value = false
    }
  }

  async function copyAiSetupCommand() {
    try {
      await navigator.clipboard.writeText(aiSetupCommand.value)
      aiSetupCopied.value = true
      setTimeout(() => { aiSetupCopied.value = false }, 1500)
    } catch (e) {
      // Clipboard may be unavailable (e.g. non-secure context); leave the command
      // visible for manual copy.
    }
  }
  onUnmounted(() => {
    if (aiRuntimePollTimer) clearInterval(aiRuntimePollTimer)
  })
  return {
    runtimeStatus,
    updateStatus,
    updateSettings,
    updateBusy,
    updateMessage,
    aiRuntimeProfiles,
    selectedAiRuntimeProfile,
    aiRuntimeJob,
    aiRuntimeBusy,
    aiRuntimeMessage,
    restartBusy,
    restartMessage,
    aiSetupCopied,
    recheckingRuntime,
    runtimeAiSummary,
    runtimeToolSummary,
    aiRuntimeProfileRows,
    aiRuntimeInstallProgress,
    aiSetupCommand,
    loadRuntimeStatus,
    restartNekoBooru,
    startAiRuntimeInstall,
    cancelAiRuntimeInstall,
    startAiRuntimePolling,
    loadUpdateStatus,
    saveUpdateSettings,
    checkForUpdates,
    recheckAiRuntime,
    copyAiSetupCommand,
  }
}
