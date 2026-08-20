const SERVICES = {
  saucenao: {
    title: 'SauceNAO',
    action: 'https://saucenao.com/search.php',
    fileField: 'file',
  },
  iqdb: {
    title: 'IQDB',
    action: 'https://iqdb.org/',
    fileField: 'file',
    hiddenFields: [
      ['MAX_FILE_SIZE', '8388608'],
      ['service[]', '1'],
      ['service[]', '2'],
      ['service[]', '3'],
      ['service[]', '4'],
      ['service[]', '5'],
      ['service[]', '6'],
      ['service[]', '11'],
      ['service[]', '13'],
    ],
  },
}

const titleEl = document.getElementById('title')
const statusEl = document.getElementById('status')
const formEl = document.getElementById('upload-form')
const fileInputEl = document.getElementById('search-image')

init()

async function init() {
  try {
    const params = new URLSearchParams(location.search)
    const key = params.get('key') || ''
    const serviceId = params.get('service') || ''
    const service = SERVICES[serviceId]
    if (!key) throw new Error('Missing temporary upload key.')
    if (!service) throw new Error('Unknown reverse-search service.')

    titleEl.textContent = `Uploading to ${service.title}`
    formEl.action = service.action
    fileInputEl.name = service.fileField
    for (const [name, value] of service.hiddenFields || []) {
      const input = document.createElement('input')
      input.type = 'hidden'
      input.name = name
      input.value = value
      formEl.appendChild(input)
    }

    const payload = await takeReverseUpload(key)
    cleanupOldReverseUploads()
    const file = fileFromReverseUpload(payload)
    const transfer = new DataTransfer()
    transfer.items.add(file)
    fileInputEl.files = transfer.files
    statusEl.textContent = `Submitting image to ${service.title}...`
    formEl.submit()
  } catch (error) {
    statusEl.textContent = error.message || 'Could not upload image.'
    statusEl.classList.add('error')
  }
}
