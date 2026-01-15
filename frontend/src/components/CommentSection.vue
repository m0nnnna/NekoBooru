<template>
  <div class="comment-section">
    <h3>Comments ({{ comments.length }})</h3>

    <form @submit.prevent="addComment" class="comment-form">
      <textarea
        v-model="newComment"
        placeholder="Write a comment..."
        rows="3"
      ></textarea>
      <button type="submit" class="btn" :disabled="!newComment.trim()">
        Post Comment
      </button>
    </form>

    <div class="comments-list">
      <div
        v-for="comment in comments"
        :key="comment.id"
        class="comment"
      >
        <div class="comment-content">
          <p>{{ comment.text }}</p>
          <div class="comment-meta">
            <span>{{ formatDate(comment.createdAt) }}</span>
            <button @click="deleteComment(comment.id)" class="delete-btn">
              Delete
            </button>
          </div>
        </div>
      </div>
      <div v-if="comments.length === 0" class="no-comments">
        No comments yet
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import api from '../api/client'

const props = defineProps({
  postId: {
    type: Number,
    required: true,
  },
})

const comments = ref([])
const newComment = ref('')

onMounted(async () => {
  await loadComments()
})

async function loadComments() {
  try {
    comments.value = await api.getComments(props.postId)
  } catch (e) {
    console.error('Failed to load comments:', e)
  }
}

async function addComment() {
  if (!newComment.value.trim()) return
  try {
    const comment = await api.createComment(props.postId, newComment.value)
    comments.value.push(comment)
    newComment.value = ''
  } catch (e) {
    alert('Failed to add comment: ' + e.message)
  }
}

async function deleteComment(id) {
  if (!confirm('Delete this comment?')) return
  try {
    await api.deleteComment(id)
    comments.value = comments.value.filter(c => c.id !== id)
  } catch (e) {
    alert('Failed to delete comment: ' + e.message)
  }
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleString()
}
</script>

<style scoped>
.comment-section {
  margin-top: 2rem;
}

.comment-section h3 {
  margin-bottom: 1rem;
}

.comment-form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 1.5rem;
}

.comment-form textarea {
  resize: vertical;
}

.comment-form button {
  align-self: flex-end;
}

.comments-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.comment {
  background: var(--bg-secondary);
  border-radius: 0.5rem;
  padding: 1rem;
}

.comment-content p {
  margin-bottom: 0.5rem;
  white-space: pre-wrap;
}

.comment-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.875rem;
  color: var(--text-secondary);
}

.delete-btn {
  background: none;
  border: none;
  color: #ef4444;
  cursor: pointer;
  padding: 0;
}

.delete-btn:hover {
  text-decoration: underline;
}

.no-comments {
  color: var(--text-secondary);
  text-align: center;
  padding: 2rem;
}
</style>
