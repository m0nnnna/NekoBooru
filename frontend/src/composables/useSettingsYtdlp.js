// Video downloads: the yt-dlp cookies file and the yt-dlp runtime updater.
import { computed, onUnmounted, ref } from 'vue'
import api from '../api/client'

export function useSettingsYtdlp({ server }) {
  const { loadSettings } = server

  const cookiesFileInput = ref(null)
  const savingCookies = ref(false)
  const cookiesStatus = ref({
    show: false,
    success: false,
    message: '',
  })
  const ytdlpStatus = ref({})
  const ytdlpSettings = ref({
    updatePolicy: 'manual',
    pinnedVersion: '',
  })
  const ytdlpBusy = ref(false)
  const ytdlpMessage = ref({
    show: false,
    success: false,
    message: '',
  })
  let ytdlpPollTimer = null

  const ytdlpJobLabel = computed(() => {
    const status = ytdlpStatus.value.job?.status || 'idle'
    if (['queued', 'running'].includes(status)) return 'Updating'
    if (status === 'completed') return 'Updated'
    if (status === 'failed') return 'Needs attention'
    return 'No update running'
  })

  const ytdlpJobDetail = computed(() => {
    const job = ytdlpStatus.value.job || {}
    if (['queued', 'running'].includes(job.status)) return `Installing ${job.target || 'latest'}...`
    if (job.status === 'completed') {
      const after = job.after_version || ytdlpStatus.value.version
      return after ? `Installed ${after}` : 'Update completed'
    }
    if (job.status === 'failed') {
      return job.error || (job.output ? 'Open pip output for details' : 'Previous update failed before details were captured')
    }
    return ytdlpStatus.value.installed ? 'Manual updates are available below' : 'Install yt-dlp to enable page-based video downloads'
  })

  const ytdlpJobClass = computed(() => {
    const status = ytdlpStatus.value.job?.status || 'idle'
    if (status === 'completed') return 'model-ok'
    if (status === 'failed') return 'model-missing'
    return ''
  })

  function triggerCookiesUpload() {
    cookiesFileInput.value?.click()
  }

  async function handleCookiesFileSelect(event) {
    const file = event.target.files?.[0]
    if (!file) return

    savingCookies.value = true
    cookiesStatus.value.show = false

    try {
      const result = await api.uploadYtdlpCookies(file)
      cookiesStatus.value = {
        show: true,
        success: true,
        message: result.message,
      }
      await loadSettings()
    } catch (e) {
      cookiesStatus.value = {
        show: true,
        success: false,
        message: e.message,
      }
    } finally {
      savingCookies.value = false
      // Reset file input so same file can be selected again
      event.target.value = ''
    }
  }

  async function deleteCookiesFile() {
    savingCookies.value = true
    cookiesStatus.value.show = false

    try {
      const result = await api.deleteYtdlpCookies()
      cookiesStatus.value = {
        show: true,
        success: true,
        message: result.message,
      }
      await loadSettings()
    } catch (e) {
      cookiesStatus.value = {
        show: true,
        success: false,
        message: e.message,
      }
    } finally {
      savingCookies.value = false
    }
  }

  async function refreshYtdlpStatus() {
    try {
      const result = await api.getYtdlpStatus()
      ytdlpStatus.value = result || {}
      ytdlpSettings.value = {
        updatePolicy: result.updatePolicy || 'manual',
        pinnedVersion: result.pinnedVersion || '',
      }
      ytdlpBusy.value = ['queued', 'running'].includes(result.job?.status)
      if (ytdlpBusy.value) startYtdlpPolling()
    } catch (e) {
      ytdlpMessage.value = {
        show: true,
        success: false,
        message: 'Failed to load yt-dlp status: ' + e.message,
      }
    }
  }

  async function saveYtdlpSettings() {
    ytdlpMessage.value.show = false
    try {
      ytdlpSettings.value = await api.updateYtdlpSettings(ytdlpSettings.value)
      ytdlpMessage.value = {
        show: true,
        success: true,
        message: 'yt-dlp settings saved.',
      }
    } catch (e) {
      ytdlpMessage.value = {
        show: true,
        success: false,
        message: 'Failed to save yt-dlp settings: ' + e.message,
      }
    }
  }

  async function startYtdlpUpdate(target) {
    const cleanTarget = target === 'latest' ? 'latest' : String(target || '').trim()
    if (!cleanTarget) return
    ytdlpBusy.value = true
    ytdlpMessage.value = {
      show: true,
      success: true,
      message: cleanTarget === 'latest' ? 'Started yt-dlp update to latest.' : `Started yt-dlp install for ${cleanTarget}.`,
    }
    try {
      ytdlpStatus.value = {
        ...ytdlpStatus.value,
        job: await api.updateYtdlp(cleanTarget),
      }
      startYtdlpPolling()
    } catch (e) {
      ytdlpBusy.value = false
      ytdlpMessage.value = {
        show: true,
        success: false,
        message: 'Failed to start yt-dlp update: ' + e.message,
      }
    }
  }

  function startYtdlpPolling() {
    if (ytdlpPollTimer) clearInterval(ytdlpPollTimer)
    ytdlpPollTimer = setInterval(async () => {
      try {
        const result = await api.getYtdlpStatus()
        ytdlpStatus.value = result || {}
        ytdlpBusy.value = ['queued', 'running'].includes(result.job?.status)
        if (!ytdlpBusy.value) {
          clearInterval(ytdlpPollTimer)
          ytdlpPollTimer = null
          ytdlpMessage.value = {
            show: true,
            success: result.job?.status === 'completed',
            message: result.job?.status === 'completed'
              ? `yt-dlp is now ${result.version || 'updated'}. Restart the backend if a downloader was already mid-run.`
              : `yt-dlp update failed: ${result.job?.error || (result.job?.output ? 'open pip output for details' : 'no error details were captured')}`,
          }
        }
      } catch (e) {
        clearInterval(ytdlpPollTimer)
        ytdlpPollTimer = null
        ytdlpBusy.value = false
        ytdlpMessage.value = {
          show: true,
          success: false,
          message: 'Failed to poll yt-dlp update: ' + e.message,
        }
      }
    }, 1200)
  }
  onUnmounted(() => {
    if (ytdlpPollTimer) clearInterval(ytdlpPollTimer)
  })
  return {
    cookiesFileInput,
    savingCookies,
    cookiesStatus,
    ytdlpStatus,
    ytdlpSettings,
    ytdlpBusy,
    ytdlpMessage,
    ytdlpJobLabel,
    ytdlpJobDetail,
    ytdlpJobClass,
    triggerCookiesUpload,
    handleCookiesFileSelect,
    deleteCookiesFile,
    refreshYtdlpStatus,
    saveYtdlpSettings,
    startYtdlpUpdate,
  }
}
