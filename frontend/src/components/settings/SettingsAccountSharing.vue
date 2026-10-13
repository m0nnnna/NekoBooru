<template>
  <p class="section-description">
    Your library is private by default. Share it read-only with specific
    other accounts on this instance, or generate a token for the browser
    extension to use.
  </p>

  <div class="form-group">
    <label>Share my library with</label>
    <p v-if="!directoryUsernames.length" class="help-text">
      No other accounts exist yet - ask an admin to create one first.
    </p>
    <div v-else class="share-checklist">
      <label v-for="name in directoryUsernames" :key="name" class="share-checklist-item">
        <input type="checkbox" :value="name" v-model="shareSelection" />
        {{ name }}
      </label>
    </div>
    <div class="form-actions" v-if="directoryUsernames.length">
      <button class="btn btn-secondary btn-small" @click="saveShares" :disabled="sharesSaving">
        {{ sharesSaving ? 'Saving...' : 'Save sharing' }}
      </button>
    </div>
    <p v-if="sharesMessage" class="status-note model-ok">{{ sharesMessage }}</p>
  </div>

  <div class="form-group" v-if="sharedWithMe.length">
    <label>Shared with me</label>
    <p class="help-text">{{ sharedWithMe.join(', ') }}</p>
  </div>

  <div class="form-group">
    <label>API Tokens</label>
    <p class="help-text">
      Used by the browser extension (and other non-browser clients) to authenticate as you.
    </p>
    <table v-if="apiTokens.length" class="users-table">
      <thead>
        <tr><th>Label</th><th>Created</th><th>Last used</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="token in apiTokens" :key="token.id">
          <td>{{ token.label }}</td>
          <td>{{ formatDate(token.createdAt) }}</td>
          <td>{{ token.lastUsedAt ? formatDate(token.lastUsedAt) : 'Never' }}</td>
          <td><button class="btn btn-danger btn-sm" @click="revokeToken(token.id)">Revoke</button></td>
        </tr>
      </tbody>
    </table>
    <div class="path-input-group">
      <input v-model="newTokenLabel" type="text" placeholder="Token label (e.g. Browser Extension)" class="path-input" />
      <button class="btn btn-secondary" @click="createToken" :disabled="tokenCreating">
        {{ tokenCreating ? 'Generating...' : 'Generate token' }}
      </button>
    </div>
    <div v-if="newRawToken" class="migration-prompt">
      <div class="alert alert-warning">
        <strong>Copy this token now</strong> - it won't be shown again.
        <p class="path-input-group">
          <input :value="newRawToken" readonly class="path-input" onclick="this.select()" />
          <button class="btn btn-secondary" @click="newRawToken = ''">Done</button>
        </p>
      </div>
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  // The object returned by useSettingsAccount().
  account: {
    type: Object,
    required: true,
  },
})

const {
  directoryUsernames,
  shareSelection,
  sharedWithMe,
  sharesSaving,
  sharesMessage,
  apiTokens,
  newTokenLabel,
  newRawToken,
  tokenCreating,
  saveShares,
  createToken,
  revokeToken,
  formatDate,
} = props.account
</script>
<style scoped>
.alert {
  padding: 1rem;
  border-radius: 0.5rem;
  border: 1px solid;
}

.btn-small {
  padding: 0.4rem 0.65rem;
  font-size: 0.8rem;
}

.share-checklist {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin: 0.5rem 0;
}

.share-checklist-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 400;
}

.users-table {
  width: 100%;
  border-collapse: collapse;
  margin: 0.75rem 0;
}

.users-table th,
.users-table td {
  text-align: left;
  padding: 0.5rem 0.6rem;
  border-bottom: 1px solid var(--border);
}
</style>
