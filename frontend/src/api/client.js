import { postsApi } from './posts.js'
import { uploadsApi } from './uploads.js'
import { autoTagsApi } from './autoTags.js'
import { tagsApi } from './tags.js'
import { settingsApi } from './settings.js'
import { authApi } from './auth.js'
import { booruSearchApi } from './booruSearch.js'

// The API client facade: one object over the per-domain modules, so every
// `import { api } from '../api/client'` (and the default import) keeps working.
export const api = {
  ...postsApi,
  ...uploadsApi,
  ...autoTagsApi,
  ...tagsApi,
  ...settingsApi,
  ...authApi,
  ...booruSearchApi,
}

export default api
