package com.nekobooru.app.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.nekobooru.app.data.AppSettings
import com.nekobooru.app.data.SyncRepository
import com.nekobooru.app.data.db.NekoDatabase
import com.nekobooru.app.data.db.PostEntity
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn

data class PoolUiState(
    val name: String = "",
    val posts: List<PostEntity> = emptyList(),
)

@OptIn(ExperimentalCoroutinesApi::class)
class PoolViewModel(app: Application) : AndroidViewModel(app) {
    private val settings = AppSettings(app)
    private val repo = SyncRepository(NekoDatabase.get(app))

    private val uuid = MutableStateFlow<String?>(null)

    val serverUrl: String get() = settings.serverUrl

    /** The pool's posts in membership order, joined against the local post cache. */
    val state: StateFlow<PoolUiState> = uuid
        .flatMapLatest { u ->
            if (u == null) flowOf(PoolUiState())
            else combine(
                repo.poolDao.observeByUuid(u),
                repo.postDao.observeVisible(),
            ) { pool, allPosts ->
                if (pool == null) return@combine PoolUiState()
                val visible = settings.visibleSafety
                val bySha = allPosts.associateBy { it.sha256 }
                PoolUiState(
                    name = pool.name,
                    posts = pool.postSha256s.mapNotNull { bySha[it] }.filter { it.safety in visible },
                )
            }
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), PoolUiState())

    fun load(poolUuid: String) { uuid.value = poolUuid }
}
