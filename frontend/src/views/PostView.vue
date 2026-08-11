<template>
  <div class="post-view" v-if="post">
    <div class="post-content">
      <div class="media-container">
        <MediaViewer
          ref="mediaViewer"
          :src="post.contentUrl"
          :alt="post.filename"
          :type="mediaType"
          @close="handleClose"
        />
        <button
          v-if="prevId != null"
          type="button"
          class="nav-arrow nav-prev"
          title="Previous post (Left arrow)"
          aria-label="Previous post"
          @click="goToPrev"
        >&#8249;</button>
        <button
          v-if="nextId != null"
          type="button"
          class="nav-arrow nav-next"
          title="Next post (Right arrow)"
          aria-label="Next post"
          @click="goToNext"
        >&#8250;</button>
      </div>
    </div>

    <aside class="post-sidebar">
      <div class="sidebar-section">
        <h3>Info</h3>
        <dl class="info-list">
          <dt>ID</dt>
          <dd>{{ post.id }}</dd>
          <dt>Size</dt>
          <dd>{{ post.width }} x {{ post.height }}</dd>
          <dt>File size</dt>
          <dd>{{ formatFileSize(post.fileSize) }}</dd>
          <dt>Type</dt>
          <dd>{{ post.extension }}</dd>
          <dt>Uploaded</dt>
          <dd>{{ formatDate(post.createdAt) }}</dd>
          <template v-if="tweetUrl">
            <dt>Tweet</dt>
            <dd>
              <a class="external-link" :href="tweetUrl" target="_blank" rel="noopener noreferrer">
                Open Tweet
              </a>
            </dd>
          </template>
          <template v-if="pixivUrl">
            <dt>Pixiv</dt>
            <dd>
              <a class="external-link" :href="pixivUrl" target="_blank" rel="noopener noreferrer">
                Open in Pixiv
              </a>
            </dd>
          </template>
          <template v-if="booruSourceLink">
            <dt>{{ booruSourceLink.label }}</dt>
            <dd>
              <a class="external-link" :href="booruSourceLink.url" target="_blank" rel="noopener noreferrer">
                Open on {{ booruSourceLink.label }}
              </a>
            </dd>
          </template>
          <dt>Rating</dt>
          <dd class="safety-buttons">
            <button
              class="safety-btn safe"
              :class="{ active: post.safety === 'safe' }"
              @click="setSafety('safe')"
              title="Safe"
            ></button>
            <button
              class="safety-btn sketchy"
              :class="{ active: post.safety === 'sketchy' }"
              @click="setSafety('sketchy')"
              title="Sketchy"
            ></button>
            <button
              class="safety-btn unsafe"
              :class="{ active: post.safety === 'unsafe' }"
              @click="setSafety('unsafe')"
              title="Unsafe"
            ></button>
          </dd>
        </dl>
      </div>

      <div v-if="semanticSidebarAnalysis" class="sidebar-section semantic-description-section">
        <h3>Semantic Description</h3>
        <div class="semantic-description-card">
          <div class="semantic-description-meta">
            <div>
              <strong>{{ semanticSidebarAnalysis.model }}</strong>
              <small>{{ semanticSidebarAnalysis.profile }}{{ semanticSidebarAnalysis.timing ? ` · ${semanticSidebarAnalysis.timing}` : '' }}</small>
            </div>
            <button
              v-if="editingAiAnalysisId !== semanticSidebarAnalysis.id"
              type="button"
              class="semantic-description-edit"
              @click="startEditAiAnalysis(semanticSidebarAnalysis)"
            >
              Edit
            </button>
          </div>
          <template v-if="editingAiAnalysisId === semanticSidebarAnalysis.id">
            <textarea
              v-model="aiAnalysisDescriptionDraft"
              class="semantic-description-editor"
              rows="8"
              spellcheck="true"
            ></textarea>
            <div class="semantic-description-actions">
              <button
                type="button"
                class="link-btn"
                @click="cancelEditAiAnalysis"
                :disabled="savingAiAnalysis"
              >
                Cancel
              </button>
              <button
                type="button"
                class="link-btn primary"
                @click="saveAiAnalysisDescription(semanticSidebarAnalysis)"
                :disabled="savingAiAnalysis"
              >
                {{ savingAiAnalysis ? 'Saving...' : 'Save' }}
              </button>
            </div>
            <small v-if="aiAnalysisEditError" class="saved-analysis-error">{{ aiAnalysisEditError }}</small>
          </template>
          <template v-else>
            <p>{{ semanticSidebarAnalysis.description }}</p>
          </template>
          <div v-if="semanticSidebarAnalysis.tags.length" class="semantic-description-tags">
            <span v-for="tag in semanticSidebarAnalysis.tags" :key="tag">{{ tag }}</span>
          </div>
        </div>
      </div>

      <div class="sidebar-section">
        <h3>Tags</h3>
        <TagSidebar :tags="post.tagDetails || post.tags" />
        <button class="btn btn-secondary edit-tags-btn" @click="openTagEditor">
          Edit Tags
        </button>
        <template v-if="autoTagControlsVisible">
        <div class="ai-profile-actions" aria-label="AI tag preview profiles">
          <button
            v-for="profile in autoTagProfiles"
            :key="profile.id"
            type="button"
            class="btn btn-secondary ai-profile-btn"
            :class="{ active: activeAutoTagProfile === profile.id }"
            :disabled="autoTagLoading"
            :data-tooltip="profile.tooltip"
            @click="previewAutoTags(profile.id)"
          >
            {{ autoTagLoading && activeAutoTagProfile === profile.id ? 'Running...' : profile.label }}
          </button>
        </div>
        <!-- Outside the model picker: it enriches whatever the models found, and
             a control that changes the result should not sit behind a details. -->
        <label class="booru-lookup-row">
          <input type="checkbox" v-model="postAutoTagSettings.booruLookupEnabled" />
          <span>
            <strong>Look up character series on Danbooru</strong>
            <small>Adds the series for recognised characters. Only adds tags; never replaces model output.</small>
          </span>
        </label>
        <div v-if="mediaType === 'video'" class="frame-picker">
          <span class="frame-picker-label">{{ framePickerLabel }}</span>
          <button type="button" class="btn btn-secondary frame-picker-btn" @click="pinCurrentFrame">
            Analyse this frame
          </button>
          <button
            type="button"
            class="btn btn-secondary frame-picker-btn"
            :disabled="videoFrameTime === null"
            @click="videoFrameTime = null"
          >Auto</button>
        </div>
        <div v-if="autoTagLoading" class="ai-inline-status">
          <div class="ai-inline-status-head">
            <strong>{{ autoTagStageTitle }}</strong>
            <span>{{ autoTagRunElapsed }}s</span>
          </div>
          <div class="auto-progress compact">
            <div class="auto-progress-fill" :style="{ width: autoTagOverallProgress + '%' }"></div>
          </div>
          <small>{{ autoTagStageMessage }}</small>
        </div>
        <details class="ai-model-picker" :open="autoModelPickerOpen" @toggle="autoModelPickerOpen = $event.target.open">
          <summary>AI models</summary>
          <div class="ai-model-list">
            <label v-for="model in postModelRows" :key="model.id" class="ai-model-row">
              <input
                type="checkbox"
                v-model="postAutoTagSettings[model.settingKey]"
                :disabled="!model.canToggle"
              />
              <span>
                <strong class="ai-model-name">
                  {{ model.name }}
                  <button
                    type="button"
                    class="ai-info-icon"
                    :data-tooltip="postModelInfoTitle(model)"
                    :aria-label="postModelInfoTitle(model)"
                    @mouseenter="showModelTooltip($event, postModelInfoTitle(model))"
                    @focus="showModelTooltip($event, postModelInfoTitle(model))"
                    @mouseleave="hideModelTooltip"
                    @blur="hideModelTooltip"
                    @click.prevent
                  >i</button>
                </strong>
                <small>
                  {{ model.statusLabel }}
                  · {{ model.loaded ? 'loaded' : 'not loaded' }}
                </small>
              </span>
              <button
                type="button"
                class="btn btn-secondary ai-load-btn"
                @click.prevent="model.loaded ? unloadAutoTagWeights(model.id) : loadAutoTagWeights(model.id)"
                :disabled="autoTagLoading || !model.downloaded || !model.runtimeAvailable"
              >
                {{ model.loaded ? 'Unload' : 'Load' }}
              </button>
            </label>
          </div>
        </details>
        </template>
      </div>

      <div class="sidebar-section">
        <h3>Similar</h3>
        <button class="btn btn-secondary similar-btn" @click="loadSimilar" :disabled="similarLoading">
          {{ similarLoading ? 'Searching...' : 'Find Similar' }}
        </button>
        <div v-if="similarLoaded && !similar.length" class="similar-empty">
          No visually similar posts found.
        </div>
        <div v-if="similar.length" class="similar-grid">
          <router-link
            v-for="item in similar"
            :key="item.post.id"
            :to="`/post/${item.post.id}`"
            class="similar-thumb"
            :title="`distance ${item.distance}`"
          >
            <img :src="item.post.thumbUrl" :alt="item.post.filename" loading="lazy" />
          </router-link>
        </div>
      </div>

      <div class="sidebar-section online-search-section">
        <h3>Search Online</h3>
        <p class="online-search-intro">
          Check exact booru files locally, or upload this post/frame to a visual search provider.
        </p>
        <div class="online-search-actions">
          <button class="btn btn-secondary" @click="findExactOnlineMatches" :disabled="onlineExactLoading">
            {{ onlineExactLoading ? 'Checking...' : 'Exact lookup' }}
          </button>
          <button class="btn btn-secondary" @click="quickLensSearch" :disabled="onlineSearchBusy !== ''">
            {{ onlineSearchBusy === 'lens' ? 'Preparing...' : 'Quick Lens' }}
          </button>
          <button class="btn" @click="fullReverseSearch" :disabled="onlineSearchBusy !== ''">
            {{ onlineSearchBusy === 'full' ? 'Starting...' : 'Full stack' }}
          </button>
        </div>
        <small class="online-search-hint">
          Exact lookup sends only an MD5 to Danbooru/Gelbooru. Quick Lens opens one tab. Full stack uses the NekoBooru extension.
        </small>
        <p v-if="onlineSearchMessage" class="online-search-message" :class="onlineSearchMessageKind">
          {{ onlineSearchMessage }}
        </p>
        <div v-if="onlineExactResult" class="online-exact-results">
          <div class="online-exact-summary">
            <strong>
              {{ onlineExactResult.matches.length
                ? `${onlineExactResult.matches.length} exact match${onlineExactResult.matches.length === 1 ? '' : 'es'}`
                : 'No byte-exact matches' }}
            </strong>
            <code>{{ onlineExactResult.md5 }}</code>
          </div>
          <a
            v-for="match in onlineExactResult.matches"
            :key="`${match.provider}-${match.id}`"
            class="online-match-row"
            :href="match.postUrl"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span>
              <strong>{{ match.providerLabel }} #{{ match.id }}</strong>
              <small>{{ match.width && match.height ? `${match.width} × ${match.height}` : 'Dimensions unknown' }}{{ match.rating ? ` · ${match.rating}` : '' }}</small>
            </span>
            <span aria-hidden="true">↗</span>
          </a>
          <small v-if="onlineExactUnavailableProviders.length" class="online-provider-warning">
            Unavailable: {{ onlineExactUnavailableProviders.join(', ') }}. Try again later or use visual search.
          </small>
          <small v-else-if="!onlineExactResult.matches.length">
            Resizing or recompression changes the MD5; use Quick Lens or Full stack next.
          </small>
        </div>
      </div>

      <div class="sidebar-section actions">
        <details class="post-optimize-menu" open>
          <summary class="post-optimize-summary">
            <span>
              <strong>Media Optimizer</strong>
              <small>Quality-controlled, review-first replacement</small>
            </span>
            <span class="optimize-state-badge" :class="postOptimizeState">
              {{ postOptimizeStateLabel }}
            </span>
          </summary>

          <div class="post-optimize-body">
            <section class="optimize-section">
              <div class="optimize-section-head">
                <div>
                  <strong>Optimization profile</strong>
                  <small>{{ postOptimizeProfileName }} settings</small>
                </div>
                <span v-if="postOptimizeProfile === 'custom'" class="optimize-custom-badge">Custom</span>
              </div>
              <MediaOptimizeProfiles
                :profiles="mediaOptimizeProfiles"
                :active-profile="postOptimizeProfile"
                compact
                @select="applyPostOptimizeProfile"
              />
            </section>

            <div class="optimize-context-grid">
              <div class="optimize-context-card">
                <span>Source</span>
                <strong>{{ postOptimizeSourceResolution }}</strong>
                <small>{{ formatFileSize(post.fileSize) }}{{ postOptimizeIsVideo && postCurrentVideoBitrate ? ` · ~${postCurrentVideoBitrate.toLocaleString()} kbps` : '' }}</small>
              </div>
              <div class="optimize-context-card target">
                <span>Target policy</span>
                <strong>{{ postOptimizeTargetResolution }}</strong>
                <small>{{ postOptimizeTargetDetail }}</small>
              </div>
            </div>

            <details class="optimize-advanced">
              <summary>
                <span>Advanced controls</span>
                <small>Fine-tune dimensions and quality budgets</small>
              </summary>
              <div class="post-optimize-grid">
                <label v-if="postOptimizeIsImage">
                  Image target
                  <select v-model="postImagePreset" @change="applyPostImagePreset">
                    <option v-for="option in postImagePresetOptions" :key="option.value" :value="option.value">
                      {{ option.label }}
                    </option>
                  </select>
                </label>
                <label v-if="postOptimizeIsImage">
                  Image quality
                  <input type="number" min="1" max="100" step="1" v-model.number="postImageQuality" @input="markPostOptimizeCustom" />
                </label>
                <label v-if="postOptimizeIsVideo">
                  Video target
                  <select v-model="postVideoPreset" @change="applyPostVideoPreset">
                    <option v-for="option in postVideoPresetOptions" :key="option.value" :value="option.value">
                      {{ option.label }}
                    </option>
                  </select>
                </label>
                <label v-if="postOptimizeIsVideo">
                  Video quality budget
                  <select v-model="postVideoBitratePreset" @change="applyPostVideoBitratePreset">
                    <option v-for="option in postVideoBitratePresetOptions" :key="option.value" :value="option.value">
                      {{ option.label }}
                    </option>
                  </select>
                </label>
                <label v-if="postOptimizeIsImage && postImagePreset === 'custom'">
                  Custom image max side
                  <input type="number" min="64" max="8192" step="16" v-model.number="postImageMaxDimension" @input="markPostOptimizeCustom" />
                </label>
                <label v-if="postOptimizeIsVideo && postVideoPreset === 'custom'">
                  Custom video max side
                  <input type="number" min="64" max="8192" step="16" v-model.number="postVideoMaxDimension" @input="markPostOptimizeCustom" />
                </label>
                <label v-if="postOptimizeIsVideo && postVideoBitratePreset === 'custom'">
                  Custom video budget (kbps)
                  <input type="number" min="64" max="50000" step="64" v-model.number="postVideoBitrateKbps" @input="markPostOptimizeCustom" />
                </label>
              </div>
            </details>

            <div class="optimize-guardrail">
              <span class="optimize-guardrail-icon" aria-hidden="true">✓</span>
              <div>
                <strong>Quality and replacement guardrails</strong>
                <small>
                  <template v-if="postOptimizeIsSocial">
                    Social mode preserves accepted source dimensions, creates an H.264/AAC MP4, and may increase
                    file size to avoid visible generational loss. X account duration and file-size limits still apply.
                  </template>
                  <template v-else>
                    Motion can burst above the selected video budget. The original is replaced only after a valid,
                    smaller output passes media inspection and duplicate checks.
                  </template>
                </small>
              </div>
            </div>

            <div
              v-if="optimizePreview"
              class="optimize-review-card"
              :class="{ growth: optimizePreviewSavings.increaseBytes > 0 }"
            >
              <div class="optimize-review-head">
                <div>
                  <span>Preview assessment</span>
                  <strong>{{ optimizePreviewAssessment }}</strong>
                </div>
                <span class="optimize-ready-pill">{{ optimizePreviewCanApply ? 'Ready to set' : 'Current retained' }}</span>
              </div>
              <div class="optimize-review-metrics">
                <div>
                  <span>Original</span>
                  <strong>{{ formatFileSize(optimizePreviewSavings.before) }}</strong>
                </div>
                <div>
                  <span>{{ optimizePreviewCanApply ? 'Optimized' : 'Reviewed' }}</span>
                  <strong>{{ formatFileSize(optimizePreviewSavings.after) }}</strong>
                </div>
                <div>
                  <span>{{ optimizePreviewStorageLabel }}</span>
                  <strong>{{ formatFileSize(optimizePreviewStorageBytes) }}</strong>
                </div>
              </div>
              <small>{{ optimizePreviewDimensionSummary }}</small>
              <small v-if="optimizePreviewGrowthExplanation" class="optimize-growth-explanation">
                {{ optimizePreviewGrowthExplanation }}
              </small>
            </div>

            <div v-if="showOptimizeJobCard" class="optimize-job-card" :class="{ error: optimizeStatusKind === 'error' }">
              <div class="optimize-job-head">
                <div>
                  <strong>{{ optimizeBusy ? 'Optimization job running' : 'Optimization job' }}</strong>
                  <small>{{ optimizeStatus || optimizeJob.message }}</small>
                </div>
                <span>{{ optimizeJobProgress }}%</span>
              </div>
              <div class="post-optimize-progress" role="progressbar" :aria-valuenow="optimizeJobProgress" aria-valuemin="0" aria-valuemax="100">
                <div class="post-optimize-progress-fill" :style="{ width: optimizeJobProgress + '%' }"></div>
              </div>
            </div>

            <div class="optimize-action-bar">
              <button
                type="button"
                class="btn"
                :disabled="optimizeBusy"
                @click="openOrCreateOptimizePreview"
              >
                {{ optimizeBusy ? 'Processing...' : 'Preview' }}
              </button>
              <button
                type="button"
                class="btn btn-danger"
                :disabled="optimizeBusy || !optimizePreviewCanApply"
                :title="optimizePreviewCanApply ? 'Set the exact reviewed file as the stored original' : 'Preview a valid result before setting it'"
                @click="requestSetOptimizePreview"
              >
                Set
              </button>
            </div>

            <small v-if="optimizeStatus && !optimizeJob" class="post-optimize-status" :class="{ error: optimizeStatusKind === 'error' }">
              {{ optimizeStatus }}
            </small>
          </div>
        </details>
        <button
          class="btn"
          :class="{ 'btn-danger': post.isFavorited }"
          @click="toggleFavorite"
        >
          {{ post.isFavorited ? '&#x1F494; Unfavorite' : '&#x1F43E; Favorite' }}
        </button>
        <button class="btn btn-secondary" @click="showPoolModal = true">
          Add to Pool
        </button>
        <button class="btn btn-danger" @click="deletePost">
          Delete
        </button>
      </div>

      <CommentSection :post-id="post.id" />
    </aside>

    <Teleport to="body">
      <div
        v-if="modelTooltip.visible"
        class="ai-model-tooltip-layer"
        :style="{ top: modelTooltip.top + 'px', left: modelTooltip.left + 'px' }"
      >
        {{ modelTooltip.text }}
      </div>
    </Teleport>

    <Teleport to="body">
      <div
        v-if="optimizePreviewOpen && optimizePreview?.previewUrl"
        class="optimize-preview-fullscreen"
        role="dialog"
        aria-modal="true"
        aria-label="Optimized media preview"
      >
        <MediaViewer
          :src="optimizePreview.previewUrl"
          :alt="`Optimized preview of ${post.filename}`"
          :type="optimizePreviewMediaType"
          @close="closeOptimizePreview"
        />
        <div class="optimize-preview-banner">
          <span>{{ optimizePreviewIsSocial ? 'Social-compatible MP4 preview' : optimizePreviewCanApply ? 'Temporary optimized preview' : 'Current file preview' }}</span>
          <strong>{{ optimizePreviewAssessment }} · {{ optimizePreviewDimensionSummary }}</strong>
        </div>
      </div>
    </Teleport>

    <div v-if="showOptimizeConfirm" class="modal-overlay" @click.self="showOptimizeConfirm = false">
      <div class="modal optimize-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="optimize-confirm-title">
        <div class="optimize-confirm-heading">
          <span class="optimize-confirm-mark" aria-hidden="true">!</span>
          <div>
            <h2 id="optimize-confirm-title">
              {{ postOptimizeApplyMode === 'create' ? 'Create a new post?' : 'Replace the stored original?' }}
            </h2>
            <p>
              The exact preview you reviewed will be used. No second encode is performed.
            </p>
          </div>
        </div>
        <div class="optimize-apply-mode" role="radiogroup" aria-label="Reviewed media destination">
          <label :class="{ active: postOptimizeApplyMode === 'replace' }">
            <input v-model="postOptimizeApplyMode" type="radio" value="replace" />
            <span>
              <strong>Replace this post</strong>
              <small>Updates the existing media while retaining this post’s metadata and relationships.</small>
            </span>
          </label>
          <label :class="{ active: postOptimizeApplyMode === 'create' }">
            <input v-model="postOptimizeApplyMode" type="radio" value="create" />
            <span>
              <strong>Create new post</strong>
              <small>Keeps this post untouched and copies its {{ post.tags.length }} tag{{ post.tags.length === 1 ? '' : 's' }}, safety, and source.</small>
            </span>
          </label>
        </div>
        <div class="optimize-confirm-impact">
          <div>
            <span>Current file</span>
            <strong>{{ formatFileSize(optimizePreviewSavings.before) }}</strong>
          </div>
          <div>
            <span>Reviewed output</span>
            <strong>{{ formatFileSize(optimizePreviewSavings.after) }}</strong>
          </div>
          <div class="positive">
            <span>{{ optimizePreviewIsSocial ? 'Storage change' : 'Storage reduction' }}</span>
            <strong>{{ optimizeConfirmStorageChange }}</strong>
          </div>
        </div>
        <div class="optimize-confirm-note">
          <template v-if="postOptimizeApplyMode === 'create'">
            NekoBooru creates a separate post after revalidating the reviewed bytes. The current post remains unchanged.
          </template>
          <template v-else>
            NekoBooru revalidates the reviewed bytes, content hash, and source version before replacing the original.
          </template>
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" @click="showOptimizeConfirm = false" :disabled="optimizeBusy">Cancel</button>
          <button
            class="btn"
            :class="{ 'btn-danger': postOptimizeApplyMode === 'replace' }"
            @click="confirmOptimizeCurrentPost"
            :disabled="optimizeBusy"
          >
            {{ optimizeBusy ? 'Applying...' : postOptimizeApplyMode === 'create' ? 'Create New Post' : 'Replace Original' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Tag Editor Modal -->
    <div v-if="showTagEditor" class="modal-overlay" @click.self="showTagEditor = false">
      <div class="modal">
        <h2>Edit Tags</h2>
        <div class="tag-editor-toolbar">
          <div class="segmented-control" aria-label="Tag editor mode">
            <button
              type="button"
              :class="{ active: tagEditorMode === 'visual' }"
              @click="setTagEditorMode('visual')"
            >
              Pills
            </button>
            <button
              type="button"
              :class="{ active: tagEditorMode === 'raw' }"
              @click="setTagEditorMode('raw')"
            >
              Text
            </button>
          </div>
          <div class="tag-editor-tools">
            <span class="tag-editor-count">{{ editedTags.length }} tags</span>
            <button type="button" class="btn btn-secondary clear-tags-btn" @click="clearEditedTags">
              Clear Tags
            </button>
          </div>
        </div>
        <TagInput v-if="tagEditorMode === 'visual'" v-model="editedTags" />
        <div v-else class="raw-tag-editor">
          <textarea
            ref="rawTagTextarea"
            v-model="rawEditedTags"
            spellcheck="false"
            placeholder="One tag per line, comma-separated tags, or a JSON array..."
            @input="onRawTagInput"
            @keydown.down.prevent="onRawTagArrowDown"
            @keydown.up.prevent="onRawTagArrowUp"
            @keydown.enter="onRawTagEnter"
            @keydown.esc="hideRawTagSuggestions"
            @blur="onRawTagBlur"
          ></textarea>
          <ul v-if="rawTagSuggestions.length > 0" class="raw-tag-suggestions">
            <li
              v-for="(tag, index) in rawTagSuggestions"
              :key="tag.name"
              :class="{ selected: index === rawTagSelectedIndex }"
              :style="{ borderLeftColor: tag.categoryColor }"
              @mousedown.prevent="selectRawTagSuggestion(tag)"
              @mouseenter="rawTagSelectedIndex = index"
            >
              <span class="tag-name">{{ tag.name }}</span>
              <span class="tag-count">{{ tag.usageCount }}</span>
            </li>
          </ul>
          <p class="raw-tag-hint">
            Accepts JSON arrays, {"tags": [...]}, commas, new lines, or spaces. Tags are normalized to lowercase underscores.
          </p>
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" @click="showTagEditor = false">Cancel</button>
          <button class="btn" @click="saveTags">Save</button>
        </div>
      </div>
    </div>

    <!-- Pool Modal -->
    <div v-if="showPoolModal" class="modal-overlay" @click.self="showPoolModal = false">
      <div class="modal">
        <h2>Add to Pool</h2>
        <select v-model="selectedPool" class="pool-select">
          <option value="">Select a pool...</option>
          <option v-for="pool in pools" :key="pool.id" :value="pool.id">
            {{ pool.name }}
          </option>
        </select>
        <div class="modal-actions">
          <button class="btn btn-secondary" @click="showPoolModal = false">Cancel</button>
          <button class="btn" @click="addToPool" :disabled="!selectedPool">Add</button>
        </div>
      </div>
    </div>

    <div v-if="showAutoTagModal" class="modal-overlay" @click.self="showAutoTagModal = false">
      <div class="modal auto-tag-preview-modal">
        <h2>AI Tag Preview</h2>
        <p v-if="autoTagTimingLabel" class="auto-timing">Completed in {{ autoTagTimingLabel }}</p>
        <div class="auto-tag-preview-body">
          <div v-if="autoTagSuggestion?.error" class="auto-error">
            {{ autoTagSuggestion.error }}
          </div>
          <div v-else>
            <div class="safety-review">
              <div>
                <strong>Safety rating</strong>
                <small>Suggested by the model. You can override before applying.</small>
              </div>
              <div class="safety-choice-group">
                <button
                  v-for="safety in safetyOptions"
                  :key="safety.value"
                  type="button"
                  class="safety-choice"
                  :class="[safety.value, { active: autoTagEditedSafety === safety.value }]"
                  @click="autoTagEditedSafety = safety.value"
                >
                  <span></span>{{ safety.label }}
                </button>
              </div>
            </div>
            <TagInput v-model="autoTagEditedTags" />
            <label v-if="autoTagHasSemanticEvidence" class="save-analysis-toggle">
              <input type="checkbox" v-model="saveSemanticAnalysisForPreview" />
              <span>
                <strong>Save Qwen semantic analysis</strong>
                <small>Stores rationale, semantic tags, raw output, and timing so semantic search can find this post by phrases.</small>
              </span>
            </label>
            <div v-if="autoTagSemanticPreview" class="semantic-preview-card">
              <div class="semantic-preview-head">
                <div>
                  <strong>Semantic Analysis</strong>
                  <small>{{ autoTagSemanticPreview.model }}{{ autoTagSemanticPreview.timing ? ` · ${autoTagSemanticPreview.timing}` : '' }}</small>
                </div>
                <span v-if="autoTagSemanticPreview.safety">{{ autoTagSemanticPreview.safety }}</span>
              </div>
              <p>{{ autoTagSemanticPreview.rationale || autoTagSemanticPreview.summary || autoTagSemanticPreview.raw }}</p>
              <div v-if="autoTagSemanticPreview.tags.length" class="semantic-preview-tags">
                <span v-for="tag in autoTagSemanticPreview.tags" :key="tag">{{ tag }}</span>
              </div>
            </div>
            <div v-if="autoTagEvidenceModels.length" class="auto-evidence">
              <h3>Model Evidence</h3>
              <div v-for="(model, index) in autoTagEvidenceModels" :key="index" class="evidence-card">
                <div class="evidence-head">
                  <strong>{{ model.model || 'Unknown model' }}</strong>
                  <span v-if="model.error" class="evidence-error">{{ model.error }}</span>
                </div>
                <dl>
                  <template v-for="item in evidenceRows(model)" :key="item.label">
                    <dt>{{ item.label }}</dt>
                    <dd>{{ item.value }}</dd>
                  </template>
                </dl>
              </div>
              <details v-if="autoTagEvidenceRaw" class="raw-evidence">
                <summary>Raw evidence</summary>
                <pre>{{ autoTagEvidenceRaw }}</pre>
              </details>
            </div>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" @click="showAutoTagModal = false">Cancel</button>
          <button v-if="autoTagSuggestion?.error" class="btn" @click="router.push('/settings')">
            Open Settings
          </button>
          <button v-else class="btn" @click="applyAutoTags" :disabled="autoTagLoading || !hasAutoTagChanges">
            Apply
          </button>
        </div>
      </div>
    </div>

    <div v-if="showAutoProcessModal" class="modal-overlay">
      <div class="modal ai-process-modal">
        <h2>{{ autoTagStageTitle }}</h2>
        <p class="auto-summary">
          {{ autoTagStageMessage }}
        </p>
        <div class="auto-progress">
          <div class="auto-progress-fill" :style="{ width: autoTagOverallProgress + '%' }"></div>
        </div>
        <p class="auto-load-meta">
          {{ autoTagOverallProgress }}% · elapsed {{ autoTagRunElapsed }}s · {{ autoTagEstimateLabel }}
        </p>
        <div class="ai-process-steps">
          <div
            v-for="step in autoTagProcessSteps"
            :key="step.key"
            class="ai-process-step"
            :class="step.state"
          >
            <span class="step-dot"></span>
            <div>
              <strong>{{ step.label }}</strong>
              <small>{{ step.detail }}</small>
            </div>
          </div>
        </div>
        <div v-if="selectedAutoTagModelRows.length" class="ai-selected-models">
          <strong>Selected models</strong>
          <ul>
            <li v-for="model in selectedAutoTagModelRows" :key="model.id">
              <span>{{ model.name }}</span>
              <small>
                {{ model.loaded ? 'loaded' : model.downloaded ? 'ready to load' : 'not downloaded' }}
                · {{ model.vramRequirement || 'VRAM varies' }}
              </small>
            </li>
          </ul>
        </div>
        <p v-if="autoLoadJob?.error" class="auto-load-error">
          {{ autoLoadJob.error }}
        </p>
        <p class="auto-load-meta">
          First loads read model weights from disk. Qwen and multi-model previews can take several minutes on CPU or when offloading.
        </p>
      </div>
    </div>
  </div>
  <div v-else-if="loading" class="loading">Loading...</div>
  <div v-else class="error">Post not found</div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../api/client'
import { usePostsStore } from '../stores/posts'
import { useTagsStore } from '../stores/tags'
import MediaViewer from '../components/MediaViewer.vue'
import TagSidebar from '../components/TagSidebar.vue'
import TagInput from '../components/TagInput.vue'
import CommentSection from '../components/CommentSection.vue'
import MediaOptimizeProfiles from '../components/MediaOptimizeProfiles.vue'
import {
  MEDIA_OPTIMIZE_PROFILES,
  MEDIA_OPTIMIZE_STORAGE_KEY,
  mediaOptimizeProfileLabel,
  mediaOptimizeProfileSettings,
  mediaOptimizeSavings,
} from '../utils/mediaOptimize'
import {
  openSearchTarget,
  requestExtensionReverseSearch,
  submitSearchFile,
} from '../utils/onlineImageSearch'
import { pixivArtworkUrlFromPost } from '../utils/sourceLinks'

const route = useRoute()
const router = useRouter()
const postsStore = usePostsStore()
const tagsStore = useTagsStore()

const post = ref(null)
const prevId = ref(null)
const nextId = ref(null)
const loading = ref(true)
const similar = ref([])
const similarLoading = ref(false)
const similarLoaded = ref(false)
const onlineExactLoading = ref(false)
const onlineExactResult = ref(null)
const onlineSearchBusy = ref('')
const onlineSearchMessage = ref('')
const onlineSearchMessageKind = ref('success')
const postAiAnalyses = ref([])
const editingAiAnalysisId = ref(null)
const aiAnalysisDescriptionDraft = ref('')
const savingAiAnalysis = ref(false)
const aiAnalysisEditError = ref('')
const showTagEditor = ref(false)
const showPoolModal = ref(false)
const showAutoTagModal = ref(false)
const editedTags = ref([])
const tagEditorMode = ref('visual')
const rawEditedTags = ref('')
const rawTagTextarea = ref(null)
const rawTagSuggestions = ref([])
const rawTagSelectedIndex = ref(-1)
const NAME_PART_AUTOCOMPLETE_KEY = 'nekobooru.namePartAutocompleteEnabled'
const DEFAULT_AUTO_TAG_MODELS = [
  {
    id: 'wd',
    name: 'WD Tagger',
    repoId: 'SmilingWolf/wd-eva02-large-tagger-v3',
    purpose: 'Booru-style image and sampled video-frame tags',
    downloadSize: '~1.2 GB',
    vramRequirement: '~0.5-1.5 GB',
  },
  {
    id: 'camie',
    name: 'Camie Tagger v2',
    repoId: 'Camais03/camie-tagger-v2',
    purpose: 'Anime character, copyright, artist, rating, and broad tag coverage',
    downloadSize: '~1-3 GB',
    vramRequirement: '~0.5-2 GB',
  },
  {
    id: 'cl',
    name: 'CL Tagger v2',
    repoId: 'cella110n/cl_tagger_v2',
    purpose: 'SigLIP2 Danbooru tagger with a 108k-tag character/copyright/general vocabulary',
    downloadSize: '~2.3 GB',
    vramRequirement: '~2-3 GB',
  },
  {
    id: 'pixai',
    name: 'PixAI Tagger v0.9',
    repoId: 'deepghs/pixai-tagger-v0.9-onnx',
    purpose: 'Fast PixAI/Danbooru anime and illustration tags',
    downloadSize: '~1.3 GB',
    vramRequirement: '~0.5-1.5 GB',
  },
  {
    id: 'qwen',
    name: 'Qwen2.5-VL 7B Instruct',
    repoId: 'Qwen/Qwen2.5-VL-7B-Instruct',
    purpose: 'Semantic video/edit understanding, political context, and natural-language evidence',
    downloadSize: '~15-17 GB',
    vramRequirement: '~14-18 GB fp16, 24 GB comfortable',
  },
  {
    id: 'ocr',
    name: 'TrOCR Printed',
    repoId: 'microsoft/trocr-base-printed',
    purpose: 'Text extraction from meme/edit frames and subtitles',
    downloadSize: '~1.3 GB',
    vramRequirement: '~1-2 GB',
  },
  {
    id: 'whisper',
    name: 'Whisper Small',
    repoId: 'openai/whisper-small',
    purpose: 'Speech/audio transcript signals for AMVs and edits',
    downloadSize: '~1 GB',
    vramRequirement: '~1-2 GB',
  },
]
const autoTagEditedTags = ref([])
const autoTagEditedSafety = ref('safe')
const autoTagSuggestion = ref(null)
const saveSemanticAnalysisForPreview = ref(false)
const autoTagLoading = ref(false)
const autoTagStatus = ref({ enabled: true, models: DEFAULT_AUTO_TAG_MODELS })
const postAutoTagSettings = ref({
  wdEnabled: true,
  pixaiEnabled: false,
  characterModelEnabled: false,
  clEnabled: false,
  booruLookupEnabled: false,
  ocrEnabled: false,
  whisperEnabled: false,
  qwenEnabled: false,
  semanticPoliticalEnabled: false,
  semanticModelId: 'qwen',
  semanticPromptEnabled: true,
  semanticSearchEnabled: false,
  saveSemanticAnalysis: false,
})
const savedAutoTagSettings = ref({ ...postAutoTagSettings.value })
const savedAutoTagProfileDefaults = ref({ custom: {}, anime: {}, realistic: {} })
const activeAutoTagProfile = ref('')
const previewAutoTagProfile = ref('post')
const autoModelPickerOpen = ref(false)
const mediaViewer = ref(null)
// Seconds into the video to analyse, taken from the player's scrubber.
// null keeps the automatic frame sampling.
const videoFrameTime = ref(null)
const showAutoProcessModal = ref(false)
const autoTagStage = ref('idle')
const autoTagStageMessage = ref('')
const autoTagRunStartedAt = ref(0)
const autoTagRunElapsed = ref(0)
const autoLoadJob = ref(null)
const modelTooltip = ref({
  visible: false,
  text: '',
  top: 0,
  left: 0,
})
let autoLoadPollTimer = null
let autoTagTickTimer = null
let rawTagDebounceTimer = null
const pools = ref([])
const selectedPool = ref('')
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

const mediaType = computed(() => {
  if (!post.value) return 'image'
  const ext = post.value.extension
  if (['.webm', '.mp4'].includes(ext)) return 'video'
  if (ext === '.gif') return 'gif'
  return 'image'
})

const onlineExactUnavailableProviders = computed(() => (
  (onlineExactResult.value?.providers || [])
    .filter((provider) => !provider.available)
    .map((provider) => provider.label)
))

const tweetUrl = computed(() => {
  const id = tweetIdFromPost(post.value)
  return id ? `https://x.com/i/status/${id}` : ''
})
const pixivUrl = computed(() => pixivArtworkUrlFromPost(post.value))
const booruSourceLink = computed(() => booruSourceLinkFromPost(post.value))
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

const safetyOptions = [
  { value: 'safe', label: 'Safe' },
  { value: 'sketchy', label: 'Sketchy' },
  { value: 'unsafe', label: 'Unsafe / NSFW' },
]

const autoTagProfiles = [
  {
    id: 'anime',
    label: 'Anime / Booru',
    tooltip: 'Best for anime, manga, illustrations, and booru-style art. Uses the Anime / Booru model stack from Settings, typically PixAI/Camie plus TrOCR; videos can add Whisper. If Qwen is enabled for Anime, it adds semantic context.',
  },
  {
    id: 'realistic',
    label: 'Realistic',
    tooltip: 'Best for realistic photos, screenshots, videos, edits, and memes. Uses the Realistic model stack from Settings. If Qwen is enabled for Realistic, it replaces WD as the primary visual/semantic model.',
  },
  {
    id: 'custom',
    label: 'Custom',
    tooltip: 'Runs exactly the model checkboxes currently selected below. This does not change your saved defaults.',
  },
]

const autoTagEvidenceRaw = computed(() => {
  if (!autoTagSuggestion.value?.evidence) return ''
  return JSON.stringify(autoTagSuggestion.value.evidence, null, 2)
})

const autoTagEvidenceModels = computed(() => {
  const evidence = autoTagSuggestion.value?.evidence
  if (!evidence) return []
  if (Array.isArray(evidence.models)) return evidence.models
  return [{ model: autoTagSuggestion.value?.model || 'Auto tagger', evidence }]
})

const autoTagHasSemanticEvidence = computed(() =>
  autoTagEvidenceModels.value.some((model) => {
    const evidence = model.evidence || {}
    const marker = `${evidence.kind || ''} ${evidence.modelId || ''} ${model.model || ''}`.toLowerCase()
    return marker.includes('qwen') || ['qwen', 'qwen_gguf'].includes(String(evidence.kind || '').toLowerCase())
  })
)

const autoTagSemanticPreview = computed(() => {
  for (const model of autoTagEvidenceModels.value) {
    const evidence = model.evidence || {}
    const parsed = semanticParsedEvidence(evidence)
    const marker = `${evidence.kind || ''} ${evidence.modelId || ''} ${model.model || ''}`.toLowerCase()
    const isSemantic = marker.includes('qwen') || ['qwen', 'qwen_gguf'].includes(String(evidence.kind || '').toLowerCase())
    if (!isSemantic) continue
    const rationale = String(parsed.rationale || parsed.description || parsed.summary || '').trim()
    const raw = String(evidence.raw || '').trim()
    const tags = Array.isArray(parsed.tags) ? parsed.tags.map(String).filter(Boolean) : []
    if (!rationale && !raw && !tags.length) continue
    return {
      model: model.model || evidence.modelId || 'Qwen',
      timing: formatDurationMs(model.durationMs ?? evidence.durationMs),
      safety: parsed.safety || '',
      rationale,
      summary: String(parsed.summary || parsed.description || '').trim(),
      raw,
      tags,
    }
  }
  return null
})

const semanticSidebarAnalysis = computed(() => {
  for (const analysis of postAiAnalyses.value || []) {
    const description = aiAnalysisDescription(analysis)
    if (!description) continue
    const rawParsed = parseSemanticRawOutput(analysis.rawOutput)
    const semanticTags = Array.isArray(analysis.semanticTags) && analysis.semanticTags.length
      ? analysis.semanticTags
      : (Array.isArray(rawParsed.tags) ? rawParsed.tags : [])
    return {
      id: analysis.id,
      model: analysis.modelName || analysis.modelId || 'Qwen',
      profile: analysis.profile || 'default',
      timing: formatDurationMs(analysis.durationMs),
      description,
      tags: semanticTags.map(String).filter(Boolean).slice(0, 12),
    }
  }
  return null
})

const autoTagTimingLabel = computed(() => {
  const duration = Number(autoTagSuggestion.value?.durationMs ?? autoTagSuggestion.value?.evidence?.durationMs)
  return Number.isFinite(duration) && duration > 0 ? formatDurationMs(duration) : ''
})

const hasAutoTagChanges = computed(() => {
  if (!post.value || !autoTagSuggestion.value) return false
  const before = [...post.value.tags].sort().join('\n')
  const after = [...autoTagEditedTags.value].sort().join('\n')
  return before !== after || autoTagEditedSafety.value !== post.value.safety
})

const autoLoadProgress = computed(() => Math.max(0, Math.min(100, Number(autoLoadJob.value?.progress || 0))))
const autoLoadEstimate = computed(() => Number(autoLoadJob.value?.estimatedSeconds || 20))
const selectedAutoTagModelRows = computed(() => enabledModelRows())
const autoTagStageTitle = computed(() => ({
  checking: 'Checking AI Tagging',
  loading: 'Loading AI Model Weights',
  analyzing: 'Analyzing Media',
  ready: 'AI Tag Preview Ready',
  failed: 'AI Tagging Failed',
}[autoTagStage.value] || 'Preparing AI Tagging'))
const autoTagOverallProgress = computed(() => {
  if (autoTagStage.value === 'checking') return 8
  if (autoTagStage.value === 'loading') return Math.max(12, Math.min(72, 12 + Math.round(autoLoadProgress.value * 0.6)))
  if (autoTagStage.value === 'analyzing') {
    const expected = currentPreviewEstimateSeconds()
    const elapsedProgress = expected ? Math.min(24, Math.round((autoTagRunElapsed.value / expected) * 24)) : 8
    return Math.min(96, 72 + elapsedProgress)
  }
  if (autoTagStage.value === 'ready') return 100
  if (autoTagStage.value === 'failed') return Math.max(8, autoLoadProgress.value)
  return 0
})
const autoTagEstimateLabel = computed(() => {
  if (autoTagStage.value === 'loading') return `model estimate ${autoLoadEstimate.value}s`
  if (autoTagStage.value === 'analyzing') return `analysis usually ${currentPreviewEstimateSeconds()}s+`
  return 'starting'
})
const autoTagProcessSteps = computed(() => {
  const selected = selectedAutoTagModelRows.value.length
  return [
    {
      key: 'check',
      label: 'Check settings',
      detail: 'Validating enabled models, downloads, and runtime packages.',
      state: stepState(['loading', 'analyzing', 'ready'], 'checking'),
    },
    {
      key: 'load',
      label: 'Load model weights',
      detail: autoLoadJob.value?.message || `${selected || 'Selected'} model${selected === 1 ? '' : 's'} will be loaded if needed.`,
      state: stepState(['analyzing', 'ready'], 'loading'),
    },
    {
      key: 'analyze',
      label: mediaType.value === 'video' ? 'Sample frames and analyze video' : 'Analyze image',
      detail: analysisDetail(),
      state: stepState(['ready'], 'analyzing'),
    },
  ]
})
const postModelRows = computed(() => {
  const models = autoTagStatus.value?.models?.length ? autoTagStatus.value.models : DEFAULT_AUTO_TAG_MODELS
  const selectedSemantic = postAutoTagSettings.value.semanticModelId || savedAutoTagSettings.value.semanticModelId || autoTagStatus.value?.semanticModelId || 'qwen'
  return models.filter((model) => !isSemanticModel(model) || model.id === selectedSemantic).map((model) => ({
    ...model,
    settingKey: modelSettingKey(model.id),
    canToggle: true,
    downloaded: model.downloaded === true,
    loaded: model.loaded === true,
    runtimeAvailable: model.runtimeAvailable !== false,
    statusLabel: model.downloaded === true ? 'downloaded' : model.downloaded === false ? 'not downloaded' : 'checking',
  }))
})
const autoTagControlsVisible = computed(() => autoTagStatus.value?.enabled !== false || autoTagStatus.value?.models?.length)

onMounted(async () => {
  await loadPost()
  loadNeighbors()
  window.addEventListener('keydown', onKeydown)
  loadPools()
  loadAutoTagControls()
})

onUnmounted(() => {
  stopAutoLoadPolling()
  stopAutoTagTimer()
  stopOptimizePolling()
  window.removeEventListener('keydown', onKeydown)
})

watch(() => route.params.id, async () => {
  await loadPost()
  loadNeighbors()
  similar.value = []
  similarLoaded.value = false
  onlineExactResult.value = null
  onlineSearchMessage.value = ''
  onlineSearchBusy.value = ''
  optimizeStatus.value = ''
  optimizePreview.value = null
  optimizePreviewOpen.value = false
  showOptimizeConfirm.value = false
  optimizeJob.value = null
  stopOptimizePolling()
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

async function loadSimilar() {
  similarLoading.value = true
  try {
    const result = await api.getSimilarPosts(route.params.id)
    similar.value = result.results || []
    similarLoaded.value = true
  } catch (e) {
    alert('Failed to find similar posts: ' + e.message)
  } finally {
    similarLoading.value = false
  }
}

function setOnlineSearchMessage(message, kind = 'success') {
  onlineSearchMessage.value = message
  onlineSearchMessageKind.value = kind
}

async function findExactOnlineMatches() {
  if (!post.value?.id || onlineExactLoading.value) return
  onlineExactLoading.value = true
  setOnlineSearchMessage('Checking exact MD5 matches on Danbooru and Gelbooru...')
  try {
    onlineExactResult.value = await api.getPostOnlineMatches(post.value.id)
    const count = onlineExactResult.value.matches?.length || 0
    setOnlineSearchMessage(
      count ? `Found ${count} byte-exact online match${count === 1 ? '' : 'es'}.` : 'Exact lookup finished; no identical files were found.',
      count ? 'success' : 'neutral',
    )
  } catch (error) {
    setOnlineSearchMessage('Exact lookup failed: ' + error.message, 'error')
  } finally {
    onlineExactLoading.value = false
  }
}

async function fileForQuickVisualSearch() {
  if (mediaType.value === 'video') {
    const frame = await mediaViewer.value?.captureCurrentFrame?.()
    if (!frame) throw new Error('The current video frame is not ready yet.')
    const name = (post.value.filename || 'nekobooru-video').replace(/\.[^.]+$/, '')
    return new File([frame], `${name}-frame.png`, { type: 'image/png' })
  }

  const response = await fetch(post.value.contentUrl, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`Could not read the post image (HTTP ${response.status}).`)
  const blob = await response.blob()
  return new File([blob], post.value.filename || 'nekobooru-search-image', {
    type: blob.type || 'application/octet-stream',
  })
}

async function quickLensSearch() {
  if (!post.value || onlineSearchBusy.value) return
  let searchTarget = null
  onlineSearchBusy.value = 'lens'
  setOnlineSearchMessage('Preparing one Google Lens search tab...')
  try {
    // Open synchronously while the click still owns popup permission; media
    // preparation can safely continue afterwards without being blocked.
    searchTarget = openSearchTarget('google')
    const file = await fileForQuickVisualSearch()
    submitSearchFile('google', searchTarget.targetName, file)
    setOnlineSearchMessage('Google Lens search opened.', 'success')
  } catch (error) {
    try { searchTarget?.targetWindow?.close() } catch { /* best effort */ }
    setOnlineSearchMessage('Quick visual search failed: ' + error.message, 'error')
  } finally {
    onlineSearchBusy.value = ''
  }
}

async function fullReverseSearch() {
  if (!post.value || onlineSearchBusy.value) return
  onlineSearchBusy.value = 'full'
  setOnlineSearchMessage('Asking the NekoBooru extension to open the full reverse-search stack...')
  try {
    await requestExtensionReverseSearch({
      mediaUrl: new URL(post.value.contentUrl, window.location.href).href,
      mediaType: mediaType.value,
      filename: post.value.filename,
    })
    setOnlineSearchMessage('Full reverse-search stack started in new tabs.', 'success')
  } catch (error) {
    setOnlineSearchMessage(error.message, 'error')
  } finally {
    onlineSearchBusy.value = ''
  }
}

async function loadNeighbors() {
  prevId.value = null
  nextId.value = null
  try {
    const ctx = postsStore.browseContext || {}
    const result = await api.getPostNeighbors(route.params.id, {
      q: ctx.query || '',
      sort: ctx.sort || 'date',
      order: ctx.order || 'desc',
    })
    prevId.value = result.prev
    nextId.value = result.next
  } catch (e) {
    // Navigation is a convenience; ignore failures (e.g. direct deep link).
  }
}

function goToPrev() {
  if (prevId.value != null) router.push(`/post/${prevId.value}`)
}

function goToNext() {
  if (nextId.value != null) router.push(`/post/${nextId.value}`)
}

function onKeydown(e) {
  // Don't hijack arrows while typing or when a modal/overlay is open.
  if (showTagEditor.value || showPoolModal.value || showAutoTagModal.value || showAutoProcessModal.value) return
  const el = e.target
  const tag = el?.tagName?.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable) return
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === 'ArrowLeft') {
    if (prevId.value != null) { e.preventDefault(); goToPrev() }
  } else if (e.key === 'ArrowRight') {
    if (nextId.value != null) { e.preventDefault(); goToNext() }
  }
}

function modelSettingKey(id) {
  return {
    wd: 'wdEnabled',
    pixai: 'pixaiEnabled',
    camie: 'characterModelEnabled',
    cl: 'clEnabled',
    ocr: 'ocrEnabled',
    whisper: 'whisperEnabled',
    qwen: 'qwenEnabled',
    qwen_gguf_q4: 'qwenEnabled',
    qwen_gguf_q8: 'qwenEnabled',
  }[id] || `${id}Enabled`
}

function isSemanticModel(model) {
  return model?.role === 'semantic' || ['qwen', 'qwen_gguf_q4', 'qwen_gguf_q8'].includes(model?.id)
}

function modelPipelineDescription(id) {
  return {
    wd: 'Runs on images and sampled video frames. Best baseline for visual library tags.',
    pixai: 'Runs fast PixAI/Danbooru anime tags on images and sampled video frames.',
    camie: 'Adds anime characters, copyright/source tags, artist tags, and rating evidence.',
    ocr: 'Reads visible captions, subtitles, and meme text from representative frames.',
    whisper: 'Extracts speech from video audio for AMVs, edits, narration, and spoken context.',
    qwen: 'Uses image plus OCR/transcript context for higher-level edit and scene meaning.',
    qwen_gguf_q4: 'Uses Qwen3-VL GGUF Q4 through llama.cpp for faster low-memory semantic tags.',
    qwen_gguf_q8: 'Uses Qwen3-VL GGUF Q8 through llama.cpp for higher-quality semantic tags.',
  }[id] || 'Use this model in the per-post auto-tagging pipeline.'
}

function postModelInfoTitle(model) {
  return [
    model.name,
    model.purpose,
    modelPipelineDescription(model.id),
    `Download size: ${model.downloadSize || 'Unknown'}`,
    `VRAM: ${model.vramRequirement || 'Unknown'}`,
    `Runtime: ${model.runtimeAvailable ? 'ready' : 'missing'}`,
    `Memory: ${model.loaded ? 'loaded' : 'not loaded'}`,
    model.providers?.length ? `Provider: ${model.providers.join(', ')}` : null,
  ].filter(Boolean).join('\n')
}

function showModelTooltip(event, text) {
  const rect = event.currentTarget.getBoundingClientRect()
  const tooltipWidth = 300
  const gap = 10
  modelTooltip.value = {
    visible: true,
    text,
    top: Math.max(12, rect.top - 8),
    left: Math.max(12, Math.min(window.innerWidth - tooltipWidth - 12, rect.left - tooltipWidth - gap)),
  }
}

function hideModelTooltip() {
  modelTooltip.value.visible = false
}

function evidenceRows(model) {
  const evidence = model.evidence || {}
  const parsed = semanticParsedEvidence(evidence)
  const rows = []
  const duration = Number(model.durationMs ?? evidence.durationMs)
  if (Number.isFinite(duration) && duration > 0) {
    rows.push({ label: 'Time', value: formatDurationMs(duration) })
  }
  if (evidence.kind) rows.push({ label: 'Source', value: evidence.kind })
  if (evidence.videoFrames) rows.push({ label: 'Frame sampling', value: formatVideoFrameSampling(evidence.videoFrames) })
  if (Array.isArray(evidence.topTags) && evidence.topTags.length) {
    rows.push({ label: 'Top tags', value: evidence.topTags.slice(0, 8).map(formatTagScore).join(', ') })
  }
  if (Array.isArray(evidence.topCharacters) && evidence.topCharacters.length) {
    rows.push({ label: 'Characters', value: evidence.topCharacters.slice(0, 8).map(formatTagScore).join(', ') })
  }
  if (Array.isArray(evidence.topCopyrights) && evidence.topCopyrights.length) {
    rows.push({ label: 'Copyrights', value: evidence.topCopyrights.slice(0, 8).map(formatTagScore).join(', ') })
  }
  if (evidence.rating && Object.keys(evidence.rating).length) {
    rows.push({ label: 'Rating evidence', value: formatScoreMap(evidence.rating) })
  }
  if (evidence.text) rows.push({ label: 'OCR text', value: evidence.text })
  if (evidence.transcript) rows.push({ label: 'Transcript', value: evidence.transcript })
  if (parsed.tags?.length) rows.push({ label: 'Semantic tags', value: parsed.tags.join(', ') })
  if (parsed.safety) rows.push({ label: 'Semantic safety', value: parsed.safety })
  if (parsed.rationale) rows.push({ label: 'Semantic analysis', value: String(parsed.rationale).slice(0, 800) })
  if (evidence.raw && !rows.some((row) => row.label === 'Semantic tags')) {
    rows.push({ label: 'Model output', value: String(evidence.raw).slice(0, 500) })
  }
  if (!rows.length && model.error) rows.push({ label: 'Status', value: model.error })
  if (!rows.length) rows.push({ label: 'Details', value: 'No structured evidence returned.' })
  return rows
}

function formatVideoFrameSampling(videoFrames) {
  if (!videoFrames || typeof videoFrames !== 'object') return ''
  const count = Number(videoFrames.count)
  const mode = String(videoFrames.mode || '')
  const label = mode === 'single'
    ? 'single middle frame'
    : mode === 'native_video_2fps'
      ? 'native video at 2 FPS'
    : mode === 'contact_sheet_2fps'
      ? '2 FPS contact sheet'
      : 'contact sheet'
  const timestamps = Array.isArray(videoFrames.timestamps)
    ? videoFrames.timestamps.slice(0, 12).map((ts) => `${Number(ts).toFixed(2)}s`).join(', ')
    : ''
  const suffix = timestamps ? ` (${timestamps}${videoFrames.timestamps.length > 12 ? ', ...' : ''})` : ''
  return `${label}${Number.isFinite(count) ? `, ${count} sampled` : ''}${suffix}`
}

function semanticParsedEvidence(evidence) {
  if (evidence?.parsed && typeof evidence.parsed === 'object') return evidence.parsed
  const raw = String(evidence?.raw || '').trim()
  if (!raw) return {}
  try {
    const match = raw.match(/\{[\s\S]*\}/)
    const parsed = JSON.parse(match ? match[0] : raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function parseSemanticRawOutput(raw) {
  const text = String(raw || '').trim()
  if (!text) return {}
  try {
    const match = text.match(/\{[\s\S]*\}/)
    const parsed = JSON.parse(match ? match[0] : text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    const rationale = extractJsonStringFragment(text, 'rationale')
    const description = extractJsonStringFragment(text, 'description')
    const summary = extractJsonStringFragment(text, 'summary')
    return { rationale, description, summary }
  }
}

function extractJsonStringFragment(text, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const quoted = new RegExp(`"${escapedKey}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'i').exec(text)
  const fragment = quoted?.[1] || new RegExp(`"${escapedKey}"\\s*:\\s*"([\\s\\S]*)$`, 'i').exec(text)?.[1] || ''
  return fragment
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/[}\],\s]*$/g, '')
    .trim()
}

function cleanSemanticDescription(value) {
  const text = String(value || '').trim()
  if (/^[{\[]/.test(text)) return ''
  return text
    .replace(/\s+/g, ' ')
    .replace(/^rationale:\s*/i, '')
    .trim()
}

function formatTagScore(item) {
  const tag = item.tag || item.name || String(item)
  const confidence = Number(item.confidence ?? item.score)
  if (!Number.isFinite(confidence)) return tag
  return `${tag} ${Math.round(confidence * 100)}%`
}

function formatScoreMap(map) {
  return Object.entries(map)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 6)
    .map(([key, value]) => `${key} ${Math.round(Number(value) * 100)}%`)
    .join(', ')
}

function formatDurationMs(ms) {
  const value = Number(ms || 0)
  if (!Number.isFinite(value) || value <= 0) return ''
  if (value < 1000) return `${Math.round(value)} ms`
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`
  const minutes = Math.floor(value / 60_000)
  const seconds = Math.round((value % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

async function loadAutoTagControls() {
  try {
    const [settingsResult, statusResult, defaultsResult] = await Promise.all([
      api.getAutoTagSettings(),
      api.getAutoTagStatus(),
      api.getAiModelDefaults(),
    ])
    const modelDefaults = normalizeAiModelDefaults(defaultsResult?.modelDefaults)
    savedAutoTagProfileDefaults.value = normalizeAiProfileDefaults(defaultsResult?.modelDefaults?.profileDefaults, modelDefaults)
    postAutoTagSettings.value = {
      ...settingsResult,
      wdEnabled: settingsResult.wdEnabled !== false,
      semanticPromptEnabled: settingsResult.semanticPromptEnabled !== false,
      semanticSearchEnabled: settingsResult.semanticSearchEnabled === true,
      saveSemanticAnalysis: settingsResult.saveSemanticAnalysis === true,
      semanticModelId: settingsResult.semanticModelId || 'qwen',
      ...modelDefaults,
    }
    if (Object.prototype.hasOwnProperty.call(modelDefaults, 'qwenEnabled')) {
      postAutoTagSettings.value.semanticPoliticalEnabled = modelDefaults.semanticPoliticalEnabled ?? modelDefaults.qwenEnabled
    }
    savedAutoTagSettings.value = { ...postAutoTagSettings.value }
    autoTagStatus.value = statusResult
  } catch (e) {
    console.error('Failed to load AI tag controls:', e)
  }
}

function normalizeAiModelDefaults(raw = {}) {
  const defaults = raw && typeof raw === 'object' ? raw : {}
  const normalized = {}
  for (const key of ['wdEnabled', 'pixaiEnabled', 'characterModelEnabled', 'clEnabled', 'qwenEnabled', 'semanticPoliticalEnabled', 'ocrEnabled', 'whisperEnabled']) {
    if (Object.prototype.hasOwnProperty.call(defaults, key)) {
      normalized[key] = defaults[key] === true
    }
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'qwenEnabled') && !Object.prototype.hasOwnProperty.call(normalized, 'semanticPoliticalEnabled')) {
    normalized.semanticPoliticalEnabled = normalized.qwenEnabled
  }
  return normalized
}

function normalizeAiProfileDefaults(raw = {}, fallback = {}) {
  const profiles = raw && typeof raw === 'object' ? raw : {}
  const defaults = {
    custom: fallback,
    anime: { wdEnabled: false, pixaiEnabled: true, characterModelEnabled: true, clEnabled: false, qwenEnabled: false, semanticPoliticalEnabled: false, ocrEnabled: true, whisperEnabled: true },
    realistic: { wdEnabled: true, pixaiEnabled: false, characterModelEnabled: false, clEnabled: false, qwenEnabled: false, semanticPoliticalEnabled: false, ocrEnabled: true, whisperEnabled: true },
  }
  return ['custom', 'anime', 'realistic'].reduce((memo, profileId) => {
    memo[profileId] = {
      ...defaults[profileId],
      ...normalizeAiModelDefaults(profiles[profileId] || {}),
    }
    return memo
  }, {})
}

async function loadPost() {
  loading.value = true
  try {
    post.value = await api.getPost(route.params.id)
    editedTags.value = [...post.value.tags]
    if (postOptimizeProfile.value !== 'custom') {
      applyPostOptimizeProfile(postOptimizeProfile.value)
    }
    loadPostAiAnalysis()
  } catch (e) {
    post.value = null
    postAiAnalyses.value = []
  } finally {
    loading.value = false
  }
}

async function loadPostAiAnalysis() {
  if (!post.value?.id) return
  try {
    const result = await api.getPostAiAnalysis(post.value.id)
    postAiAnalyses.value = result.results || []
  } catch {
    postAiAnalyses.value = []
  }
}

function aiAnalysisDescription(analysis) {
  if (analysis?.description) return String(analysis.description).trim()
  return cleanSemanticDescription(
    semanticDescriptionFromField(analysis?.rationale) ||
    semanticDescriptionFromField(analysis?.summary) ||
    semanticDescriptionFromField(analysis?.rawOutput)
  )
}

function semanticDescriptionFromField(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (!/^[{\[]/.test(text)) return text
  const parsed = parseSemanticRawOutput(text)
  return (
    parsed.rationale ||
    parsed.description ||
    parsed.summary ||
    parsed.scene ||
    ''
  )
}

function startEditAiAnalysis(analysis) {
  editingAiAnalysisId.value = analysis.id
  aiAnalysisDescriptionDraft.value = aiAnalysisDescription(analysis)
  aiAnalysisEditError.value = ''
}

function cancelEditAiAnalysis() {
  editingAiAnalysisId.value = null
  aiAnalysisDescriptionDraft.value = ''
  aiAnalysisEditError.value = ''
}

async function saveAiAnalysisDescription(analysis) {
  if (!post.value?.id || !analysis?.id) return
  savingAiAnalysis.value = true
  aiAnalysisEditError.value = ''
  try {
    const updated = await api.updatePostAiAnalysis(post.value.id, analysis.id, {
      description: aiAnalysisDescriptionDraft.value,
    })
    postAiAnalyses.value = postAiAnalyses.value.map((item) => (
      item.id === updated.id ? updated : item
    ))
    cancelEditAiAnalysis()
  } catch (error) {
    aiAnalysisEditError.value = error.message || 'Failed to save description.'
  } finally {
    savingAiAnalysis.value = false
  }
}

async function loadPools() {
  try {
    const result = await api.getPools()
    pools.value = result.results
  } catch (e) {
    console.error('Failed to load pools:', e)
  }
}

async function toggleFavorite() {
  try {
    const result = await api.toggleFavorite(post.value.id)
    post.value.isFavorited = result.isFavorited
  } catch (e) {
    alert('Failed to toggle favorite: ' + e.message)
  }
}

function openTagEditor() {
  editedTags.value = [...(post.value?.tags || [])]
  tagEditorMode.value = 'visual'
  rawEditedTags.value = tagsToRawText(editedTags.value)
  showTagEditor.value = true
}

function setTagEditorMode(mode) {
  if (mode === tagEditorMode.value) return
  if (tagEditorMode.value === 'raw') {
    editedTags.value = parseRawTags(rawEditedTags.value)
    hideRawTagSuggestions()
  } else {
    rawEditedTags.value = tagsToRawText(editedTags.value)
  }
  tagEditorMode.value = mode
}

function clearEditedTags() {
  editedTags.value = []
  rawEditedTags.value = ''
  hideRawTagSuggestions()
}

function tagsToRawText(tags) {
  return (tags || []).join('\n')
}

function normalizeTagName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '_')
}

function parseRawTags(raw) {
  const text = String(raw || '').trim()
  if (!text) return []

  let values = null
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) values = parsed
      else if (Array.isArray(parsed?.tags)) values = parsed.tags
    } catch {
      values = null
    }
  }

  if (!values) {
    values = text.split(/[\s,]+/)
  }

  const seen = new Set()
  const tags = []
  for (const value of values) {
    const tag = normalizeTagName(value)
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    tags.push(tag)
  }
  return tags
}

function rawTagTokenAtCursor() {
  const textarea = rawTagTextarea.value
  const value = rawEditedTags.value || ''
  const cursor = textarea?.selectionStart ?? value.length
  let start = cursor
  while (start > 0 && !/[\s,\[\]{}"']/.test(value[start - 1])) start -= 1
  let end = cursor
  while (end < value.length && !/[\s,\[\]{}"']/.test(value[end])) end += 1
  const rawToken = value.slice(start, end)
  const token = rawToken.startsWith('-') ? rawToken.slice(1) : rawToken
  return { start, end, rawToken, token }
}

function onRawTagInput() {
  clearTimeout(rawTagDebounceTimer)
  rawTagDebounceTimer = setTimeout(async () => {
    const { token } = rawTagTokenAtCursor()
    if (!token || token.includes(':')) {
      hideRawTagSuggestions()
      return
    }
    rawTagSuggestions.value = await tagsStore.autocomplete(token, tagAutocompleteOptions())
    rawTagSelectedIndex.value = rawTagSuggestions.value.length ? 0 : -1
  }, 150)
}

function tagAutocompleteOptions() {
  return {
    nameParts: localStorage.getItem(NAME_PART_AUTOCOMPLETE_KEY) === 'true',
    // The server only acts on this when booru suggestions are switched on.
    includeRemote: true,
  }
}

function selectRawTagSuggestion(tag) {
  if (!tag?.name) return
  tagsStore.rememberRemoteTag(tag)
  const { start, end, rawToken } = rawTagTokenAtCursor()
  const prefix = rawToken.startsWith('-') ? '-' : ''
  const before = rawEditedTags.value.slice(0, start)
  const after = rawEditedTags.value.slice(end)
  const inserted = `${prefix}${tag.name}`
  rawEditedTags.value = `${before}${inserted}${after}`
  hideRawTagSuggestions()
  requestAnimationFrame(() => {
    rawTagTextarea.value?.focus()
    const caret = before.length + inserted.length
    rawTagTextarea.value?.setSelectionRange(caret, caret)
  })
}

function onRawTagEnter(event) {
  if (!rawTagSuggestions.value.length) return
  event.preventDefault()
  const index = rawTagSelectedIndex.value >= 0 ? rawTagSelectedIndex.value : 0
  selectRawTagSuggestion(rawTagSuggestions.value[index])
}

function onRawTagArrowDown() {
  if (!rawTagSuggestions.value.length) return
  rawTagSelectedIndex.value = (rawTagSelectedIndex.value + 1) % rawTagSuggestions.value.length
}

function onRawTagArrowUp() {
  if (!rawTagSuggestions.value.length) return
  rawTagSelectedIndex.value = rawTagSelectedIndex.value <= 0
    ? rawTagSuggestions.value.length - 1
    : rawTagSelectedIndex.value - 1
}

function hideRawTagSuggestions() {
  rawTagSuggestions.value = []
  rawTagSelectedIndex.value = -1
}

function onRawTagBlur() {
  setTimeout(hideRawTagSuggestions, 150)
}

async function saveTags() {
  try {
    if (tagEditorMode.value === 'raw') {
      editedTags.value = parseRawTags(rawEditedTags.value)
    }
    // Carry the category/spelling of any tag picked from a remote booru
    // suggestion; the library has never seen it, so nothing else can.
    const meta = tagsStore.tagMetadataFor(editedTags.value)
    await api.updatePost(post.value.id, {
      tags: editedTags.value,
      tagCategories: meta.categories,
      tagDisplayNames: meta.displayNames,
    })
    await loadPost()
    showTagEditor.value = false
  } catch (e) {
    alert('Failed to save tags: ' + e.message)
  }
}

async function previewAutoTags(profileId = 'custom') {
  autoTagLoading.value = true
  activeAutoTagProfile.value = profileId
  previewAutoTagProfile.value = profileId
  applyAutoTagProfile(profileId)
  beginAutoTagProcess('checking', 'Checking settings, selected models, and local runtime packages.')
  try {
    autoTagStatus.value = await api.getAutoTagStatus()
    if (!autoTagStatus.value.enabled) {
      autoTagSuggestion.value = {
        error: 'AI tagging is disabled. Enable Auto Tagging in Settings first.',
        suggestedTags: post.value.tags,
        suggestedSafety: post.value.safety,
      }
      autoTagEditedTags.value = [...post.value.tags]
      autoTagEditedSafety.value = post.value.safety || 'safe'
      showAutoTagModal.value = true
      return
    }

    const missingDeps = selectedMissingBackendPackages()
    if (missingDeps.length > 0) {
      autoTagSuggestion.value = {
        error: `AI tagging is missing optional backend packages: ${missingDeps.join(', ')}. Install backend/requirements-tagger.txt and restart the backend.`,
        suggestedTags: post.value.tags,
        suggestedSafety: post.value.safety,
      }
      autoTagEditedTags.value = [...post.value.tags]
      autoTagEditedSafety.value = post.value.safety || 'safe'
      showAutoTagModal.value = true
      return
    }

    await loadEnabledAutoTagModels()

    beginAutoTagStage('analyzing', analysisDetail())
    autoTagSuggestion.value = await api.previewAutoTags(post.value.id, {
      settings: autoTagRunSettings(),
    })
    autoTagEditedTags.value = [...(autoTagSuggestion.value.suggestedTags || post.value.tags)]
    autoTagEditedSafety.value = autoTagSuggestion.value.suggestedSafety || post.value.safety || 'safe'
    saveSemanticAnalysisForPreview.value = Boolean(postAutoTagSettings.value.saveSemanticAnalysis)
    beginAutoTagStage('ready', 'Preview is ready. Review the suggested tags and safety rating before applying.')
    showAutoTagModal.value = true
  } catch (e) {
    beginAutoTagStage('failed', e.message)
    alert(`Failed to preview AI tags: ${e.message}\n\nLarge Qwen runs can take a while. If the backend is still healthy, try again after the model finishes loading.`)
  } finally {
    autoTagLoading.value = false
    activeAutoTagProfile.value = ''
    showAutoProcessModal.value = false
    stopAutoTagTimer()
  }
}

function applyAutoTagProfile(profileId) {
  const profileSettings = autoTagProfileSettings(profileId)
  if (!profileSettings) return
  postAutoTagSettings.value = {
    ...postAutoTagSettings.value,
    ...profileSettings,
  }
}

function autoTagProfileSettings(profileId) {
  if (profileId === 'custom') return null
  const isVideo = mediaType.value === 'video'
  const profileDefaults = savedAutoTagProfileDefaults.value?.[profileId] || {}
  const useSemanticQwen = [
    profileDefaults.qwenEnabled,
    postAutoTagSettings.value.qwenEnabled,
  ].some(Boolean)
  if (profileId === 'anime') {
    return {
      wdEnabled: profileDefaults.wdEnabled === true,
      pixaiEnabled: profileDefaults.pixaiEnabled === true,
      characterModelEnabled: profileDefaults.characterModelEnabled !== false,
      clEnabled: profileDefaults.clEnabled === true,
      ocrEnabled: profileDefaults.ocrEnabled !== false,
      whisperEnabled: isVideo && profileDefaults.whisperEnabled !== false,
      qwenEnabled: useSemanticQwen,
      semanticPoliticalEnabled: useSemanticQwen,
      semanticModelId: savedAutoTagSettings.value.semanticModelId || 'qwen',
      generalThreshold: 0.35,
      characterThreshold: 0.45,
      maxTags: 40,
      ...(isVideo ? {
        videoMaxFrames: 4,
        qwenVideoUseFps: savedAutoTagSettings.value.qwenVideoUseFps === true,
        qwenVideoMaxFrames: savedAutoTagSettings.value.qwenVideoMaxFrames || 20,
      } : {}),
    }
  }
  if (profileId === 'realistic') {
    return {
      wdEnabled: useSemanticQwen ? false : profileDefaults.wdEnabled !== false,
      pixaiEnabled: profileDefaults.pixaiEnabled === true,
      characterModelEnabled: profileDefaults.characterModelEnabled === true,
      clEnabled: profileDefaults.clEnabled === true,
      ocrEnabled: profileDefaults.ocrEnabled !== false,
      whisperEnabled: isVideo && profileDefaults.whisperEnabled !== false,
      qwenEnabled: useSemanticQwen,
      semanticPoliticalEnabled: useSemanticQwen,
      semanticModelId: savedAutoTagSettings.value.semanticModelId || 'qwen',
      generalThreshold: 0.5,
      characterThreshold: 0.6,
      maxTags: isVideo ? 20 : 18,
      ...(isVideo ? {
        videoMaxFrames: 4,
        qwenVideoUseFps: savedAutoTagSettings.value.qwenVideoUseFps === true,
        qwenVideoMaxFrames: savedAutoTagSettings.value.qwenVideoMaxFrames || 20,
      } : {}),
    }
  }
  return null
}

function autoTagRunSettings() {
  const qwenEnabled = postAutoTagSettings.value.qwenEnabled === true
  return {
    ...postAutoTagSettings.value,
    qwenEnabled,
    semanticPoliticalEnabled: qwenEnabled,
    videoFrameTime: mediaType.value === 'video' ? videoFrameTime.value : null,
    enabled: true,
  }
}

function pinCurrentFrame() {
  const time = mediaViewer.value?.currentVideoTime?.()
  videoFrameTime.value = Number.isFinite(time) ? Math.max(0, time) : null
}

const framePickerLabel = computed(() => {
  if (videoFrameTime.value === null) return 'AI samples frames automatically'
  const total = Math.max(0, videoFrameTime.value)
  const minutes = Math.floor(total / 60)
  return `AI analyses ${minutes}:${(total - minutes * 60).toFixed(1).padStart(4, '0')}`
})

function enabledModelRows() {
  return postModelRows.value.filter((model) => Boolean(postAutoTagSettings.value[model.settingKey]))
}

function selectedMissingBackendPackages() {
  const missing = new Set()
  enabledModelRows().forEach((model) => {
    dependenciesForModel(model).forEach((name) => {
      if (autoTagStatus.value.dependencies?.[name] === false) missing.add(name)
    })
  })
  return Array.from(missing)
}

function dependenciesForModel(model) {
  if (!model) return []
  if (model.id === 'wd' || model.id === 'pixai' || model.id === 'camie' || model.id === 'cl') return ['onnxruntime', 'numpy', 'pillow']
  if (model.id === 'ocr') return ['transformers', 'torch']
  if (model.id === 'whisper') return ['transformers', 'transformers_pipeline', 'torch']
  if (model.id === 'qwen') return ['transformers', 'torch', 'qwen_vl_utils']
  if (model.id === 'qwen_gguf_q4' || model.id === 'qwen_gguf_q8') return ['llama_cpp']
  return []
}

async function loadEnabledAutoTagModels() {
  if (autoTagStatus.value?.remote?.enabled && autoTagStatus.value?.remote?.url) {
    beginAutoTagStage('loading', 'Using the configured AI worker. The worker will load model weights during analysis if needed.')
    return
  }
  for (const model of enabledModelRows()) {
    if (!model.downloaded || !model.runtimeAvailable || model.loaded) continue
    await loadAutoTagWeights(model.id, { keepOpen: true })
  }
}

async function loadAutoTagWeights(modelId = 'wd', options = {}) {
  const keepOpen = Boolean(options.keepOpen)
  const message = `Starting ${modelLabel(modelId)} model load.`
  if (showAutoProcessModal.value) {
    beginAutoTagStage('loading', message)
  } else {
    beginAutoTagProcess('loading', message)
  }
  try {
    autoLoadJob.value = await api.loadAutoTagModelById(modelId)
    if (autoLoadJob.value?.message) autoTagStageMessage.value = autoLoadJob.value.message
    await new Promise((resolve, reject) => {
      autoLoadPollTimer = setInterval(async () => {
        try {
          autoLoadJob.value = await api.getAutoTagModelLoadJob()
          if (autoLoadJob.value?.message) {
            autoTagStageMessage.value = autoLoadJob.value.message
          }
          if (!autoLoadJob.value || !['queued', 'running'].includes(autoLoadJob.value.status)) {
            stopAutoLoadPolling()
            if (autoLoadJob.value?.status === 'failed') {
              reject(new Error(autoLoadJob.value.error || 'Model load failed'))
              return
            }
            resolve()
          }
        } catch (e) {
          stopAutoLoadPolling()
          reject(e)
        }
      }, 700)
    })
    autoTagStatus.value = await api.getAutoTagStatus()
  } finally {
    if (!keepOpen) {
      showAutoProcessModal.value = false
      stopAutoTagTimer()
    }
  }
}

async function unloadAutoTagWeights(modelId) {
  autoTagLoading.value = true
  try {
    const result = await api.unloadAutoTagModelById(modelId)
    if (autoTagStatus.value) {
      autoTagStatus.value.models = result.models || autoTagStatus.value.models
      if (modelId === 'wd') autoTagStatus.value.modelLoaded = false
    } else {
      autoTagStatus.value = await api.getAutoTagStatus()
    }
  } catch (e) {
    alert('Failed to unload model: ' + e.message)
  } finally {
    autoTagLoading.value = false
  }
}

function stopAutoLoadPolling() {
  if (autoLoadPollTimer) clearInterval(autoLoadPollTimer)
  autoLoadPollTimer = null
}

function beginAutoTagProcess(stage, message) {
  showAutoProcessModal.value = true
  autoLoadJob.value = null
  autoTagRunStartedAt.value = Date.now()
  autoTagRunElapsed.value = 0
  beginAutoTagStage(stage, message)
  stopAutoTagTimer()
  autoTagTickTimer = setInterval(() => {
    autoTagRunElapsed.value = Math.max(0, Math.round((Date.now() - autoTagRunStartedAt.value) / 1000))
  }, 500)
}

function beginAutoTagStage(stage, message) {
  autoTagStage.value = stage
  autoTagStageMessage.value = message || ''
  if (stage !== 'loading') {
    autoLoadJob.value = null
  }
}

function stopAutoTagTimer() {
  if (autoTagTickTimer) clearInterval(autoTagTickTimer)
  autoTagTickTimer = null
}

function stepState(completedStages, activeStage) {
  if (completedStages.includes(autoTagStage.value)) return 'completed'
  if (autoTagStage.value === activeStage) return 'active'
  if (autoTagStage.value === 'failed') return 'failed'
  return 'pending'
}

function modelLabel(modelId) {
  return postModelRows.value.find((model) => model.id === modelId)?.name || 'AI'
}

function currentPreviewEstimateSeconds() {
  const ids = selectedAutoTagModelRows.value.map((model) => model.id)
  let estimate = mediaType.value === 'video' ? 45 : 20
  if (ids.includes('qwen')) estimate += mediaType.value === 'video' ? 150 : 90
  if (ids.includes('whisper')) estimate += 45
  if (ids.includes('ocr')) estimate += 20
  if (ids.includes('camie')) estimate += 20
  return estimate
}

function analysisDetail() {
  const names = selectedAutoTagModelRows.value.map((model) => model.name)
  const joined = names.length ? names.join(', ') : 'selected models'
  if (mediaType.value === 'video') {
    return `Sampling frames and running ${joined}. Qwen or audio transcript passes may run longer.`
  }
  return `Running ${joined} against this image and preparing tag evidence.`
}

async function applyAutoTags() {
  autoTagLoading.value = true
  try {
    post.value = await api.applyAutoTags(post.value.id, {
      tags: autoTagEditedTags.value,
      safety: autoTagEditedSafety.value || post.value.safety,
      categories: autoTagSuggestion.value?.categories || {},
      settings: autoTagRunSettings(),
      suggestion: autoTagSuggestion.value || {},
      saveAnalysis: saveSemanticAnalysisForPreview.value === true,
      profile: previewAutoTagProfile.value || 'post',
    })
    editedTags.value = [...post.value.tags]
    await loadPostAiAnalysis()
    showAutoTagModal.value = false
  } catch (e) {
    alert('Failed to apply AI tags: ' + e.message)
  } finally {
    autoTagLoading.value = false
  }
}

async function setSafety(safety) {
  if (post.value.safety === safety) return
  const oldSafety = post.value.safety
  post.value.safety = safety
  try {
    await api.updatePost(post.value.id, { safety })
  } catch (e) {
    alert('Failed to update safety: ' + e.message)
    post.value.safety = oldSafety
  }
}

async function addToPool() {
  if (!selectedPool.value) return
  try {
    await api.addPostsToPool(selectedPool.value, [post.value.id])
    showPoolModal.value = false
    selectedPool.value = ''
    alert('Added to pool')
  } catch (e) {
    alert('Failed to add to pool: ' + e.message)
  }
}

async function deletePost() {
  if (!confirm('Are you sure you want to delete this post?')) return
  try {
    await api.deletePost(post.value.id)
    router.back()
  } catch (e) {
    alert('Failed to delete post: ' + e.message)
  }
}

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

function handleClose() {
  router.back()
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString()
}

function tweetIdFromPost(value) {
  if (!value) return ''
  const tag = (value.tags || []).find((name) => /^twitter_\d+$/.test(name) || /^tweet_\d+$/.test(name))
  if (tag) return tag.match(/\d+/)?.[0] || ''
  return tweetIdFromUrl(value.source)
}

function tweetIdFromUrl(raw) {
  if (!raw) return ''
  try {
    const url = new URL(raw)
    const host = url.hostname.toLowerCase()
    if (!/(^|\.)x\.com$|(^|\.)twitter\.com$/.test(host)) return ''
    return url.pathname.match(/\/status\/(\d+)/)?.[1] || ''
  } catch {
    return ''
  }
}

// Mirrors BOORU_SITES in browser-extension/booru-tags.js - keep the host
// lists in step. Only used to label a link back to post.source, so it needs
// no post-id parsing of its own: several of these siteIds (gelbooru,
// moebooru) cover multiple actual domains, so there is no way to rebuild a
// working URL from a saved "gelbooru_12345"-style tag alone. post.source -
// the exact page the post was downloaded from - is the only reliable source.
const BOORU_SOURCE_HOSTS = [
  { label: 'Danbooru', matches: (host) => host === 'donmai.us' || host.endsWith('.donmai.us') },
  { label: 'e621', matches: (host) => host === 'e621.net' || host === 'e926.net' },
  { label: 'Moebooru', matches: (host) => ['yande.re', 'konachan.com', 'konachan.net'].includes(host) },
  {
    label: 'Gelbooru',
    matches: (host) => [
      'gelbooru.com',
      'safebooru.org',
      'rule34.xxx',
      'tbib.org',
      'xbooru.com',
      'realbooru.com',
      'hypnohub.net',
    ].includes(host),
  },
]

function booruSourceLinkFromPost(value) {
  const raw = value?.source
  if (!raw) return null
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const host = url.hostname.replace(/^www\./, '').toLowerCase()
  const site = BOORU_SOURCE_HOSTS.find((entry) => entry.matches(host))
  return site ? { url: raw, label: site.label } : null
}
</script>

<style scoped>
.post-view {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  gap: 1.5rem;
  height: calc(100vh - 120px);
}

.post-content {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.media-container {
  position: relative;
  height: 100%;
  width: 100%;
  border-radius: 0.75rem;
  overflow: hidden;
  background: var(--bg-secondary);
}

.nav-arrow {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 64px;
  border: none;
  border-radius: 0.5rem;
  background: rgba(0, 0, 0, 0.4);
  color: #fff;
  font-size: 2rem;
  line-height: 1;
  cursor: pointer;
  opacity: 0.55;
  transition: opacity 0.15s, background 0.15s;
}

.nav-arrow:hover {
  opacity: 1;
  background: rgba(0, 0, 0, 0.65);
}

.nav-prev {
  left: 0.5rem;
}

.nav-next {
  right: 0.5rem;
}

@media (max-width: 480px) {
  .nav-arrow {
    width: 38px;
    height: 54px;
    font-size: 1.6rem;
  }
}

.post-sidebar {
  background: var(--bg-secondary);
  border-radius: 0.75rem;
  padding: 1.25rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  border: 1px solid var(--border);
}

.sidebar-section h3 {
  font-size: 0.75rem;
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  margin-bottom: 0.75rem;
  font-weight: 600;
}

.info-list {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.5rem 1rem;
  font-size: 0.875rem;
}

.info-list dt {
  color: var(--text-secondary);
}

.info-list dd {
  color: var(--text-primary);
  font-weight: 500;
}

.external-link {
  color: var(--accent);
  text-decoration: none;
  font-weight: 700;
}

.external-link:hover {
  text-decoration: underline;
}

.safety-buttons {
  display: flex;
  gap: 0.35rem;
}

.safety-btn {
  width: 22px;
  height: 22px;
  border-radius: 4px;
  border: none;
  cursor: pointer;
  opacity: 0.3;
  transition: opacity 0.15s, transform 0.15s, box-shadow 0.15s;
}

.safety-btn:hover {
  transform: scale(1.1);
}

.safety-btn.active {
  opacity: 1;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.safety-btn.safe {
  background: #4ade80;
}

.safety-btn.sketchy {
  background: #facc15;
}

.safety-btn.unsafe {
  background: #f87171;
}

.edit-tags-btn {
  margin-top: 0.75rem;
  width: 100%;
}

.similar-btn {
  width: 100%;
}

.similar-empty {
  margin-top: 0.5rem;
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.similar-grid {
  margin-top: 0.75rem;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.4rem;
}

.similar-thumb {
  display: block;
  aspect-ratio: 1;
  border-radius: 0.4rem;
  overflow: hidden;
  background: var(--bg-tertiary);
}

.similar-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.online-search-intro {
  margin: 0 0 0.65rem;
  color: var(--text-secondary);
  font-size: 0.8rem;
  line-height: 1.4;
}

.online-search-actions {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.4rem;
}

.online-search-actions .btn {
  min-width: 0;
  padding: 0.55rem 0.35rem;
  font-size: 0.76rem;
  line-height: 1.2;
  white-space: normal;
}

.online-search-hint,
.online-exact-results > small {
  display: block;
  margin-top: 0.55rem;
  color: var(--text-secondary);
  font-size: 0.7rem;
  line-height: 1.4;
}

.online-search-message {
  margin: 0.65rem 0 0;
  padding: 0.5rem 0.6rem;
  border: 1px solid rgba(34, 197, 94, 0.35);
  border-radius: 0.45rem;
  background: rgba(34, 197, 94, 0.08);
  color: #86efac;
  font-size: 0.74rem;
  line-height: 1.35;
}

.online-search-message.neutral {
  border-color: var(--border);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}

.online-search-message.error,
.online-provider-warning {
  border-color: rgba(239, 68, 68, 0.4);
  background: rgba(239, 68, 68, 0.08);
  color: #fca5a5;
}

.online-exact-results {
  display: grid;
  gap: 0.45rem;
  margin-top: 0.65rem;
}

.online-exact-summary {
  display: grid;
  gap: 0.25rem;
}

.online-exact-summary code {
  overflow-wrap: anywhere;
  color: var(--text-secondary);
  font-size: 0.66rem;
}

.online-match-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.55rem 0.65rem;
  border: 1px solid var(--border);
  border-radius: 0.45rem;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  text-decoration: none;
}

.online-match-row:hover {
  border-color: var(--accent);
}

.online-match-row > span:first-child {
  display: grid;
  gap: 0.1rem;
}

.online-match-row small {
  color: var(--text-secondary);
  font-size: 0.68rem;
}

.ai-profile-actions {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.45rem;
  margin-top: 0.75rem;
}

.ai-profile-btn {
  position: relative;
  min-width: 0;
  padding: 0.55rem 0.45rem;
  font-size: 0.78rem;
  line-height: 1.2;
  white-space: normal;
}

.ai-profile-btn.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.ai-profile-btn::after {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 10px);
  z-index: 80;
  display: block;
  width: max-content;
  max-width: min(320px, 76vw);
  padding: 0.6rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: 0.45rem;
  background: #111827;
  color: #f8fafc;
  box-shadow: 0 14px 30px rgba(0, 0, 0, 0.38);
  content: attr(data-tooltip);
  font-size: 0.74rem;
  font-weight: 500;
  line-height: 1.35;
  text-align: left;
  white-space: normal;
  opacity: 0;
  pointer-events: none;
  transform: translate(-50%, 4px);
  transition: opacity 0.12s ease, transform 0.12s ease;
}

.ai-profile-btn:hover::after,
.ai-profile-btn:focus-visible::after {
  opacity: 1;
  transform: translate(-50%, 0);
}

.ai-inline-status {
  margin-top: 0.75rem;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
}

.ai-inline-status-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.45rem;
  color: var(--text-primary);
  font-size: 0.82rem;
}

.ai-inline-status-head span,
.ai-inline-status small {
  color: var(--text-secondary);
  font-size: 0.74rem;
}

.ai-model-picker {
  margin-top: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
}

.frame-picker {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.5rem;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
}

.frame-picker-label {
  flex: 1;
  min-width: 0;
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.frame-picker-btn {
  padding: 0.3rem 0.55rem;
  font-size: 0.75rem;
  white-space: nowrap;
}

.booru-lookup-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: flex-start;
  gap: 0.55rem;
  margin-top: 0.75rem;
  padding: 0.6rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
  color: var(--text-primary);
  cursor: pointer;
}

.booru-lookup-row input {
  margin-top: 0.2rem;
}

.booru-lookup-row strong {
  display: block;
  font-size: 0.85rem;
}

.booru-lookup-row small {
  display: block;
  margin-top: 0.15rem;
  color: var(--text-secondary);
  font-size: 0.75rem;
  line-height: 1.35;
}

.ai-model-picker summary {
  cursor: pointer;
  padding: 0.65rem 0.75rem;
  color: var(--text-primary);
  font-weight: 600;
  font-size: 0.9rem;
}

.ai-model-list {
  display: grid;
  gap: 0.5rem;
  padding: 0 0.75rem 0.75rem;
}

.ai-model-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.55rem;
  color: var(--text-primary);
  font-size: 0.85rem;
}

.ai-model-row small {
  display: block;
  color: var(--text-secondary);
  font-size: 0.72rem;
  margin-top: 0.1rem;
}

.ai-model-name {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  min-width: 0;
}

.ai-info-icon {
  position: relative;
  flex: 0 0 auto;
  width: 17px;
  height: 17px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  cursor: help;
  font-size: 0.68rem;
  font-weight: 700;
  line-height: 15px;
}

.ai-info-icon:hover,
.ai-info-icon:focus-visible {
  color: var(--text-primary);
  border-color: var(--accent);
}

.ai-load-btn {
  padding: 0.35rem 0.55rem;
  font-size: 0.78rem;
  min-width: 58px;
}

.save-analysis-toggle {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.65rem;
  align-items: start;
  margin: 0.9rem 0;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-secondary);
  color: var(--text-primary);
  cursor: pointer;
}

.save-analysis-toggle small {
  display: block;
  margin-top: 0.2rem;
  color: var(--text-secondary);
  font-size: 0.78rem;
  line-height: 1.35;
}

.saved-analysis-card {
  padding: 0.65rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
}

.saved-analysis-card + .saved-analysis-card {
  margin-top: 0.5rem;
}

.saved-analysis-card summary {
  display: grid;
  gap: 0.15rem;
  cursor: pointer;
  color: var(--text-primary);
  font-weight: 700;
}

.saved-analysis-card summary small {
  color: var(--text-secondary);
  font-size: 0.72rem;
  font-weight: 500;
}

.saved-analysis-body {
  display: grid;
  gap: 0.55rem;
  margin-top: 0.65rem;
  color: var(--text-secondary);
  font-size: 0.82rem;
  line-height: 1.4;
}

.saved-analysis-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.saved-analysis-tags span {
  padding: 0.2rem 0.4rem;
  border: 1px solid var(--accent);
  border-radius: 0.35rem;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 0.72rem;
}

.saved-analysis-body pre {
  max-height: 140px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  padding: 0.55rem;
  border-radius: 0.4rem;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 0.72rem;
}

.saved-analysis-editor {
  width: 100%;
  min-height: 120px;
  resize: vertical;
  padding: 0.55rem;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font: inherit;
  line-height: 1.45;
}

.saved-analysis-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.45rem;
}

.saved-analysis-edit {
  justify-self: start;
}

.saved-analysis-error {
  color: var(--coral);
}

.semantic-description-card {
  display: grid;
  gap: 0.65rem;
  padding: 0.7rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-primary);
}

.semantic-description-meta {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}

.semantic-description-meta > div {
  display: grid;
  min-width: 0;
  gap: 0.18rem;
}

.semantic-description-meta strong {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 0.82rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.semantic-description-meta small {
  color: var(--text-secondary);
  font-size: 0.72rem;
  white-space: nowrap;
}

.semantic-description-card p {
  max-height: 170px;
  margin: 0;
  overflow: auto;
  padding-right: 0.25rem;
  color: var(--text-secondary);
  font-size: 0.82rem;
  line-height: 1.45;
}

.semantic-description-edit {
  flex: 0 0 auto;
  padding: 0.18rem 0.45rem;
  border: 1px solid var(--border);
  border-radius: 0.35rem;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 0.78rem;
  line-height: 1.1;
}

.semantic-description-edit:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.semantic-description-editor {
  width: 100%;
  min-height: 145px;
  resize: vertical;
  padding: 0.55rem;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font: inherit;
  line-height: 1.45;
}

.semantic-description-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
}

.semantic-description-actions .link-btn.primary {
  color: var(--accent);
  font-weight: 700;
}

.semantic-description-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.semantic-description-tags span {
  padding: 0.16rem 0.4rem;
  border: 1px solid rgba(96, 165, 250, 0.55);
  border-radius: 0.35rem;
  background: rgba(96, 165, 250, 0.12);
  color: var(--accent);
  font-size: 0.7rem;
}

.ai-model-tooltip-layer {
  position: fixed;
  z-index: 5000;
  width: 300px;
  max-width: calc(100vw - 24px);
  padding: 0.65rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.45rem;
  background: #111827;
  color: #f8fafc;
  box-shadow: 0 18px 42px rgba(0, 0, 0, 0.45);
  font-size: 0.76rem;
  font-weight: 500;
  line-height: 1.4;
  text-align: left;
  white-space: pre-line;
  pointer-events: none;
}

.actions {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.post-optimize-menu {
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  background: linear-gradient(180deg, var(--bg-primary), var(--bg-tertiary));
  overflow: hidden;
}

.post-optimize-summary {
  cursor: pointer;
  list-style: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.85rem;
  color: var(--text-primary);
}

.post-optimize-summary::-webkit-details-marker {
  display: none;
}

.post-optimize-summary > span:first-child {
  display: grid;
  min-width: 0;
  gap: 0.15rem;
}

.post-optimize-summary strong {
  font-size: 0.92rem;
}

.post-optimize-summary small {
  color: var(--text-secondary);
  font-size: 0.72rem;
  line-height: 1.3;
}

.optimize-state-badge,
.optimize-custom-badge,
.optimize-ready-pill {
  flex: 0 0 auto;
  padding: 0.2rem 0.45rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 0.64rem;
  font-weight: 800;
  letter-spacing: 0.025em;
  text-transform: uppercase;
}

.optimize-state-badge.running {
  border-color: rgba(96, 165, 250, 0.55);
  color: var(--accent);
}

.optimize-state-badge.ready,
.optimize-ready-pill {
  border-color: rgba(129, 178, 154, 0.65);
  background: var(--success-soft);
  color: var(--success);
}

.optimize-state-badge.error {
  border-color: rgba(224, 122, 95, 0.65);
  background: var(--coral-soft);
  color: var(--coral);
}

.post-optimize-body {
  display: grid;
  gap: 0.75rem;
  padding: 0 0.85rem 0.85rem;
  border-top: 1px solid var(--border);
}

.optimize-section {
  display: grid;
  gap: 0.55rem;
  padding-top: 0.75rem;
}

.optimize-section-head,
.optimize-review-head,
.optimize-job-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}

.optimize-section-head > div,
.optimize-review-head > div,
.optimize-job-head > div {
  display: grid;
  min-width: 0;
  gap: 0.15rem;
}

.optimize-section-head strong,
.optimize-review-head strong,
.optimize-job-head strong {
  color: var(--text-primary);
  font-size: 0.82rem;
}

.optimize-section-head small,
.optimize-job-head small {
  color: var(--text-secondary);
  font-size: 0.7rem;
  line-height: 1.35;
}

.optimize-context-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.55rem;
}

.optimize-context-card {
  display: grid;
  min-width: 0;
  gap: 0.15rem;
  padding: 0.65rem;
  border: 1px solid var(--border);
  border-radius: 0.6rem;
  background: rgba(0, 0, 0, 0.07);
}

.optimize-context-card.target {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  background: var(--accent-soft);
}

.optimize-context-card span,
.optimize-review-metrics span,
.optimize-confirm-impact span {
  color: var(--text-secondary);
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.optimize-context-card strong {
  min-width: 0;
  color: var(--text-primary);
  font-size: 0.8rem;
  overflow-wrap: anywhere;
}

.optimize-context-card small {
  color: var(--text-secondary);
  font-size: 0.66rem;
  line-height: 1.35;
}

.optimize-advanced {
  border: 1px solid var(--border);
  border-radius: 0.6rem;
  background: rgba(0, 0, 0, 0.06);
}

.optimize-advanced > summary {
  cursor: pointer;
  list-style: none;
  display: flex;
  flex-direction: column;
  padding: 0.65rem;
}

.optimize-advanced > summary::-webkit-details-marker {
  display: none;
}

.optimize-advanced > summary span {
  color: var(--text-primary);
  font-size: 0.8rem;
  font-weight: 700;
}

.optimize-advanced > summary small {
  color: var(--text-secondary);
  font-size: 0.68rem;
}

.post-optimize-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0.55rem;
  padding: 0 0.65rem 0.65rem;
}

.post-optimize-grid label {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  color: var(--text-secondary);
  font-size: 0.82rem;
}

.post-optimize-grid input,
.post-optimize-grid select {
  min-width: 0;
  width: 100%;
  color: var(--text-primary);
}

.optimize-guardrail {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.6rem;
  padding: 0.65rem;
  border: 1px solid rgba(129, 178, 154, 0.45);
  border-radius: 0.6rem;
  background: var(--success-soft);
}

.optimize-guardrail-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--success);
  color: white;
  font-size: 0.75rem;
  font-weight: 900;
}

.optimize-guardrail > div {
  display: grid;
  gap: 0.15rem;
}

.optimize-guardrail strong {
  color: var(--text-primary);
  font-size: 0.76rem;
}

.optimize-guardrail small {
  color: var(--text-secondary);
  font-size: 0.68rem;
  line-height: 1.4;
}

.optimize-review-card,
.optimize-job-card {
  display: grid;
  gap: 0.6rem;
  padding: 0.7rem;
  border: 1px solid rgba(129, 178, 154, 0.55);
  border-radius: 0.65rem;
  background: linear-gradient(135deg, var(--success-soft), rgba(0, 0, 0, 0.05));
}

.optimize-review-head span:first-child {
  color: var(--text-secondary);
  font-size: 0.68rem;
}

.optimize-review-head strong {
  font-size: 1rem;
}

.optimize-review-metrics,
.optimize-confirm-impact {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.45rem;
}

.optimize-review-metrics > div,
.optimize-confirm-impact > div {
  display: grid;
  min-width: 0;
  gap: 0.12rem;
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--bg-primary) 72%, transparent);
}

.optimize-review-metrics strong,
.optimize-confirm-impact strong {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 0.77rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.optimize-review-card > small {
  color: var(--text-secondary);
  font-size: 0.68rem;
}

.optimize-review-card.growth {
  border-color: color-mix(in srgb, var(--warning, #f2c14e) 68%, var(--border));
  background: linear-gradient(135deg, rgba(242, 193, 78, 0.12), rgba(0, 0, 0, 0.05));
}

.optimize-review-card .optimize-growth-explanation {
  padding: 0.55rem 0.6rem;
  border: 1px solid color-mix(in srgb, var(--warning, #f2c14e) 40%, var(--border));
  border-radius: 0.45rem;
  background: color-mix(in srgb, var(--warning, #f2c14e) 8%, transparent);
  color: var(--text-primary);
  line-height: 1.4;
}

.optimize-job-card {
  border-color: rgba(96, 165, 250, 0.45);
  background: var(--accent-soft);
}

.optimize-job-card.error {
  border-color: rgba(224, 122, 95, 0.55);
  background: var(--coral-soft);
}

.optimize-job-head > span {
  color: var(--accent);
  font-size: 0.78rem;
  font-weight: 800;
}

.optimize-action-bar {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.5rem;
}

.optimize-action-bar .btn {
  min-width: 0;
  padding-inline: 0.7rem;
  font-size: 0.78rem;
}

.optimize-action-bar .btn:disabled {
  opacity: 0.48;
  cursor: not-allowed;
  transform: none;
}

.post-optimize-status {
  display: block;
  color: var(--text-secondary);
  font-size: 0.72rem;
  line-height: 1.35;
}

.post-optimize-progress {
  height: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
}

.post-optimize-progress-fill {
  height: 100%;
  min-width: 4px;
  border-radius: inherit;
  background: var(--accent);
  transition: width 0.25s ease;
}

.post-optimize-status.error {
  color: var(--coral, #f87171);
}

.optimize-preview-fullscreen {
  position: fixed;
  inset: 0;
  z-index: 3000;
  width: 100vw;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  background: #000;
}

.optimize-preview-fullscreen :deep(.media-viewer) {
  border-radius: 0;
  background: #000;
}

.optimize-preview-banner {
  position: fixed;
  top: 1rem;
  left: 1rem;
  z-index: 3010;
  display: grid;
  max-width: min(420px, calc(100vw - 6rem));
  gap: 0.1rem;
  padding: 0.65rem 0.8rem;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 0.6rem;
  background: rgba(8, 12, 18, 0.82);
  color: white;
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(10px);
  pointer-events: none;
}

.optimize-preview-banner span {
  color: rgba(255, 255, 255, 0.65);
  font-size: 0.67rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.optimize-preview-banner strong {
  font-size: 0.78rem;
}

.optimize-confirm-modal {
  width: min(560px, calc(100vw - 2rem));
}

.optimize-confirm-heading {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.8rem;
  align-items: flex-start;
}

.optimize-confirm-heading h2 {
  margin: 0;
  font-size: 1.05rem;
}

.optimize-confirm-heading p {
  margin-top: 0.25rem;
  color: var(--text-secondary);
  font-size: 0.82rem;
  line-height: 1.45;
}

.optimize-confirm-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--coral-soft);
  color: var(--coral);
  font-weight: 900;
}

.optimize-confirm-impact {
  margin-top: 1rem;
}

.optimize-apply-mode {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.6rem;
  margin-top: 1rem;
}

.optimize-apply-mode label {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: flex-start;
  gap: 0.55rem;
  padding: 0.7rem;
  border: 1px solid var(--border);
  border-radius: 0.6rem;
  background: var(--bg-secondary);
  cursor: pointer;
}

.optimize-apply-mode label.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  box-shadow: 0 0 0 1px var(--accent);
}

.optimize-apply-mode input {
  margin-top: 0.2rem;
}

.optimize-apply-mode span {
  display: grid;
  gap: 0.2rem;
}

.optimize-apply-mode strong {
  color: var(--text-primary);
  font-size: 0.8rem;
}

.optimize-apply-mode small {
  color: var(--text-secondary);
  font-size: 0.7rem;
  line-height: 1.4;
}

.optimize-confirm-impact .positive {
  border-color: rgba(129, 178, 154, 0.55);
  background: var(--success-soft);
}

.optimize-confirm-impact .positive strong {
  color: var(--success);
}

.optimize-confirm-note {
  margin-top: 0.8rem;
  padding: 0.7rem;
  border: 1px solid var(--border);
  border-radius: 0.55rem;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 0.76rem;
  line-height: 1.45;
}

.optimize-confirm-modal .modal-actions {
  margin-top: 1rem;
}

.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  background: var(--bg-primary);
  border-radius: 0.75rem;
  padding: 1.5rem;
  width: 450px;
  max-width: 90vw;
  border: 1px solid var(--border);
  box-shadow: 0 20px 40px var(--shadow);
}

.auto-tag-preview-modal {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  width: min(470px, calc(100vw - 24px));
  max-height: calc(100dvh - 24px);
  padding: 0;
  overflow: hidden;
}

.auto-tag-preview-modal h2 {
  margin: 0;
  padding: 1.25rem 1.25rem 0.35rem;
}

.auto-tag-preview-modal .auto-timing {
  margin: 0;
  padding: 0 1.25rem 0.75rem;
}

.auto-tag-preview-body {
  min-height: 0;
  overflow-y: auto;
  padding: 0 1.25rem 1rem;
}

.auto-tag-preview-modal .modal-actions {
  position: sticky;
  bottom: 0;
  margin: 0;
  padding: 0.9rem 1.25rem 1.25rem;
  border-top: 1px solid var(--border);
  background: linear-gradient(180deg, rgba(17, 24, 39, 0.92), var(--bg-primary) 35%);
}

.modal h2 {
  margin-bottom: 1.25rem;
  color: var(--text-primary);
}

.auto-tag-preview-modal h2 {
  margin-bottom: 0;
}

.auto-timing {
  margin: -0.8rem 0 1rem;
  color: var(--text-secondary);
  font-size: 0.82rem;
}

.tag-editor-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}

.segmented-control {
  display: inline-flex;
  padding: 0.2rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-secondary);
}

.segmented-control button {
  min-width: 4rem;
  padding: 0.4rem 0.7rem;
  border: 0;
  border-radius: 0.35rem;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-weight: 600;
}

.segmented-control button.active {
  background: var(--accent);
  color: #fff;
}

.tag-editor-count {
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.tag-editor-tools {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
}

.clear-tags-btn {
  padding: 0.4rem 0.7rem;
  font-size: 0.82rem;
}

.raw-tag-editor textarea {
  width: 100%;
  min-height: 260px;
  resize: vertical;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-secondary);
  color: var(--text-primary);
  padding: 0.75rem;
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  font-size: 0.9rem;
  line-height: 1.45;
}

.raw-tag-editor textarea:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.raw-tag-suggestions {
  margin: 0.4rem 0 0;
  padding: 0;
  list-style: none;
  max-height: 180px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-secondary);
  box-shadow: 0 4px 12px var(--shadow);
}

.raw-tag-suggestions li {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  border-left: 3px solid transparent;
  color: var(--text-primary);
  cursor: pointer;
}

.raw-tag-suggestions li:hover,
.raw-tag-suggestions li.selected {
  background: var(--bg-tertiary);
}

.raw-tag-hint {
  margin: 0.5rem 0 0;
  color: var(--text-secondary);
  font-size: 0.8rem;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 1.25rem;
}

.auto-summary {
  margin-bottom: 0.75rem;
  color: var(--text-secondary);
}

.ai-process-modal {
  width: 520px;
}

.ai-process-steps {
  display: grid;
  gap: 0.65rem;
  margin: 1rem 0;
}

.ai-process-step {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.7rem;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-secondary);
}

.ai-process-step strong {
  display: block;
  color: var(--text-primary);
  font-size: 0.86rem;
  margin-bottom: 0.15rem;
}

.ai-process-step small {
  display: block;
  color: var(--text-secondary);
  font-size: 0.78rem;
  line-height: 1.35;
}

.step-dot {
  width: 11px;
  height: 11px;
  margin-top: 0.2rem;
  border-radius: 999px;
  background: var(--border);
  box-shadow: 0 0 0 4px rgba(148, 163, 184, 0.08);
}

.ai-process-step.active .step-dot {
  background: var(--accent);
  box-shadow: 0 0 0 4px var(--accent-soft);
}

.ai-process-step.completed .step-dot {
  background: #4ade80;
  box-shadow: 0 0 0 4px rgba(74, 222, 128, 0.13);
}

.ai-process-step.failed .step-dot {
  background: #f87171;
  box-shadow: 0 0 0 4px rgba(248, 113, 113, 0.14);
}

.ai-selected-models {
  padding: 0.8rem;
  margin-top: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-secondary);
}

.ai-selected-models > strong {
  display: block;
  margin-bottom: 0.55rem;
  color: var(--text-primary);
  font-size: 0.85rem;
}

.ai-selected-models ul {
  display: grid;
  gap: 0.45rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.ai-selected-models li {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  color: var(--text-primary);
  font-size: 0.8rem;
}

.ai-selected-models small {
  color: var(--text-secondary);
  text-align: right;
}

.safety-review {
  display: grid;
  gap: 0.75rem;
  padding: 0.85rem;
  margin-bottom: 1rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-secondary);
}

.safety-review strong {
  display: block;
  color: var(--text-primary);
  margin-bottom: 0.15rem;
}

.safety-review small {
  color: var(--text-secondary);
}

.safety-choice-group {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.5rem;
}

.safety-choice {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  min-height: 38px;
  padding: 0.45rem 0.55rem;
  border: 1px solid var(--border);
  border-radius: 0.45rem;
  background: var(--bg-primary);
  color: var(--text-secondary);
  cursor: pointer;
  font-weight: 600;
  font-size: 0.82rem;
}

.safety-choice span {
  width: 10px;
  height: 10px;
  border-radius: 3px;
}

.safety-choice.safe span {
  background: #4ade80;
}

.safety-choice.sketchy span {
  background: #facc15;
}

.safety-choice.unsafe span {
  background: #f87171;
}

.safety-choice.active {
  color: var(--text-primary);
  border-color: var(--accent);
  background: var(--accent-soft);
}

.auto-error {
  padding: 0.75rem;
  background: var(--coral-soft);
  border: 1px solid var(--coral);
  border-radius: 0.5rem;
  color: var(--text-primary);
}

.semantic-preview-card {
  display: grid;
  gap: 0.65rem;
  margin-top: 1rem;
  padding: 0.85rem;
  border: 1px solid rgba(96, 165, 250, 0.38);
  border-radius: 0.55rem;
  background: rgba(96, 165, 250, 0.08);
}

.semantic-preview-head {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
  justify-content: space-between;
}

.semantic-preview-head div {
  display: grid;
  gap: 0.15rem;
}

.semantic-preview-head strong {
  color: var(--text-primary);
}

.semantic-preview-head small {
  color: var(--text-secondary);
  font-size: 0.78rem;
}

.semantic-preview-head span {
  padding: 0.2rem 0.5rem;
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
}

.semantic-preview-card p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.86rem;
  line-height: 1.45;
}

.semantic-preview-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.semantic-preview-tags span {
  padding: 0.2rem 0.4rem;
  border: 1px solid rgba(96, 165, 250, 0.48);
  border-radius: 0.35rem;
  color: var(--accent);
  font-size: 0.72rem;
}

.auto-evidence {
  margin-top: 1rem;
  max-height: 240px;
  overflow: auto;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  padding: 0.75rem;
}

.auto-evidence h3 {
  margin: 0 0 0.65rem;
  color: var(--text-primary);
  font-size: 0.9rem;
}

.evidence-card {
  padding: 0.75rem;
  margin-bottom: 0.6rem;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 0.45rem;
}

.evidence-card:last-of-type {
  margin-bottom: 0;
}

.evidence-head {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.6rem;
  color: var(--text-primary);
}

.evidence-error {
  color: var(--coral);
  font-size: 0.78rem;
}

.evidence-card dl {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: 0.45rem 0.75rem;
  margin: 0;
}

.evidence-card dt {
  color: var(--text-secondary);
  font-size: 0.78rem;
}

.evidence-card dd {
  margin: 0;
  color: var(--text-primary);
  font-size: 0.8rem;
  overflow-wrap: anywhere;
}

.raw-evidence {
  margin-top: 0.75rem;
  color: var(--text-secondary);
  font-size: 0.8rem;
}

.raw-evidence summary {
  cursor: pointer;
}

.raw-evidence pre {
  margin: 0.5rem 0 0;
  padding: 0.75rem;
  max-height: 180px;
  overflow: auto;
  color: #f3f4f6;
  background: #111827;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  white-space: pre-wrap;
  font-size: 0.75rem;
}

.auto-progress {
  height: 10px;
  background: var(--bg-secondary);
  border-radius: 5px;
  overflow: hidden;
  margin: 1rem 0 0.5rem;
}

.auto-progress.compact {
  height: 7px;
  margin: 0 0 0.45rem;
  background: rgba(148, 163, 184, 0.18);
}

.auto-progress-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.25s ease;
}

.auto-load-meta {
  color: var(--text-secondary);
  font-size: 0.85rem;
  margin: 0.4rem 0;
}

.auto-load-error {
  padding: 0.65rem 0.75rem;
  color: #fecaca;
  background: rgba(127, 29, 29, 0.28);
  border: 1px solid rgba(248, 113, 113, 0.55);
  border-radius: 0.45rem;
  font-size: 0.82rem;
  line-height: 1.45;
  white-space: pre-wrap;
}

.pool-select {
  width: 100%;
}

.loading, .error {
  text-align: center;
  padding: 3rem;
  color: var(--text-secondary);
}

.loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
}

/* Mobile responsive styles */
@media (max-width: 768px) {
  .post-view {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(300px, 60vh) auto;
    height: auto;
    gap: 1rem;
  }

  .post-content {
    min-height: 300px;
  }

  .media-container {
    border-radius: 0.5rem;
  }

  .post-sidebar {
    padding: 1rem;
    gap: 1rem;
    border-radius: 0.5rem;
  }

  .sidebar-section h3 {
    font-size: 0.7rem;
    margin-bottom: 0.5rem;
  }

  .info-list {
    font-size: 0.8rem;
    gap: 0.35rem 0.75rem;
  }

  .safety-btn {
    width: 28px;
    height: 28px;
  }

  .actions {
    flex-direction: row;
    flex-wrap: wrap;
  }

  .actions .btn {
    flex: 1;
    min-width: 100px;
  }

  .post-optimize-menu {
    flex: 1 1 100%;
  }

  .optimize-context-grid,
  .optimize-review-metrics,
  .optimize-confirm-impact,
  .optimize-apply-mode {
    grid-template-columns: 1fr;
  }

  .optimize-action-bar {
    grid-template-columns: 1fr;
  }

  .modal {
    padding: 1.25rem;
    margin: 1rem;
    max-height: 90vh;
    overflow-y: auto;
  }

  .auto-tag-preview-modal {
    width: calc(100vw - 24px);
    max-height: calc(100dvh - 24px);
    margin: 0;
    padding: 0;
    overflow: hidden;
  }

  .auto-tag-preview-body {
    overflow-y: auto;
  }

  .modal h2 {
    font-size: 1.1rem;
    margin-bottom: 1rem;
  }

  .auto-tag-preview-modal h2 {
    margin-bottom: 0;
  }

  .modal-actions {
    flex-direction: column;
    gap: 0.5rem;
  }

  .auto-tag-preview-modal .modal-actions {
    flex-direction: column;
    margin: 0;
  }

  .modal-actions .btn {
    width: 100%;
  }
}

@media (max-width: 480px) {
  .post-view {
    grid-template-rows: minmax(250px, 50vh) auto;
    gap: 0.75rem;
  }

  .post-sidebar {
    padding: 0.875rem;
  }

  .actions .btn {
    font-size: 0.8rem;
    padding: 0.5rem 0.75rem;
  }

  .edit-tags-btn {
    font-size: 0.85rem;
  }
}
</style>
