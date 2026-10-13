const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Run with: node browser-extension/upload-ai-models.test.js
// upload-ai-models.js is a plain popup script; load it the way upload.html does,
// with the globals it reads from upload.js stubbed.

function loadModels({ mediaType = 'image', fetchResult } = {}) {
  const source = fs.readFileSync(path.join(__dirname, 'upload-ai-models.js'), 'utf8')
  const booruLookups = []
  const context = vm.createContext({
    mediaType,
    instanceUrl: 'http://127.0.0.1:1',
    autoTagSettings: {},
    autoTagSavedSettings: {},
    autoTagStatus: {},
    autoTagModelOverrides: {},
    extensionUploadDefaults: {},
    setBooruLookup: (value) => booruLookups.push(value),
    NekoAuth: {
      authFetch: async () => {
        if (fetchResult instanceof Error) throw fetchResult
        return { ok: true, json: async () => fetchResult }
      },
    },
  })
  const api = vm.runInContext(`${source}
;({ aiTagProfile, resolveAiTagProfileId, applyExtensionModelDefaults, modelSettingKey, dependenciesForModel,
    isSemanticModel, aiTagProfileQwenReplaces, loadAiModelRegistry, registry: () => aiModelRegistry })`, context)
  return { api, context, booruLookups }
}

async function main() {
  const { api, context, booruLookups } = loadModels()

  // The built-in profiles are the ones the popup has always run.
  const anime = {
    wdEnabled: false, pixaiEnabled: true, characterModelEnabled: true, clEnabled: false, qwenEnabled: false,
    ocrEnabled: true, semanticPoliticalEnabled: false, generalThreshold: 0.35, characterThreshold: 0.45, maxTags: 40,
  }
  const realistic = {
    wdEnabled: true, pixaiEnabled: false, characterModelEnabled: false, clEnabled: false, qwenEnabled: false,
    ocrEnabled: true, semanticPoliticalEnabled: false, generalThreshold: 0.5, characterThreshold: 0.6,
  }
  const plain = (value) => JSON.parse(JSON.stringify(value))
  assert.deepEqual(plain(api.aiTagProfile('anime_image').settings), { ...anime, whisperEnabled: false })
  assert.deepEqual(plain(api.aiTagProfile('anime_video').settings), { ...anime, whisperEnabled: true, videoMaxFrames: 4 })
  assert.deepEqual(plain(api.aiTagProfile('realistic_image').settings), { ...realistic, whisperEnabled: false, maxTags: 18 })
  assert.deepEqual(plain(api.aiTagProfile('realistic_video').settings), { ...realistic, whisperEnabled: true, maxTags: 20, videoMaxFrames: 4 })
  assert.equal(api.aiTagProfile('custom').settings, null)
  assert.equal(api.resolveAiTagProfileId('anime'), 'anime_image')
  assert.equal(loadModels({ mediaType: 'video' }).api.resolveAiTagProfileId('realistic'), 'realistic_video')
  assert.deepEqual(plain(api.aiTagProfileQwenReplaces('realistic')), ['wdEnabled'])
  assert.deepEqual(plain(api.aiTagProfileQwenReplaces('anime')), [])

  assert.equal(api.modelSettingKey('camie'), 'characterModelEnabled')
  assert.equal(api.modelSettingKey('qwen_gguf_q8'), 'qwenEnabled')
  assert.deepEqual(plain(api.dependenciesForModel({ id: 'whisper' })), ['transformers', 'transformers_pipeline', 'torch'])
  assert.equal(api.isSemanticModel({ id: 'qwen_gguf_q4' }), true)
  assert.equal(api.isSemanticModel({ id: 'wd' }), false)

  // Saved defaults seed every registry flag; booru lookup goes through its setter.
  api.applyExtensionModelDefaults({ clEnabled: true, qwenEnabled: true, booruLookupEnabled: true })
  assert.deepEqual(plain(context.autoTagModelOverrides), { clEnabled: true, qwenEnabled: true, semanticPoliticalEnabled: true })
  assert.deepEqual(booruLookups, [true])

  // A server registry replaces the fallback; an unreachable server keeps it.
  const served = { ...plain(api.registry()), models: [{ id: 'new_model', settingKey: 'newModelEnabled', runtimePackages: ['x'] }] }
  const online = loadModels({ fetchResult: served }).api
  await online.loadAiModelRegistry()
  assert.equal(online.modelSettingKey('new_model'), 'newModelEnabled')
  const offline = loadModels({ fetchResult: new Error('offline') }).api
  await offline.loadAiModelRegistry()
  assert.equal(offline.modelSettingKey('camie'), 'characterModelEnabled')

  console.log('upload-ai-models tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
