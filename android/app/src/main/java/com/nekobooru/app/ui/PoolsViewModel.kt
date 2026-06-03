package com.nekobooru.app.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.nekobooru.app.data.SyncManager
import com.nekobooru.app.data.SyncRepository
import com.nekobooru.app.data.db.NekoDatabase
import com.nekobooru.app.data.db.PoolEntity
import com.nekobooru.app.sync.SyncScheduler
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.util.UUID

/** Lists pools and lets the user create one. Backed by Room so it works offline. */
class PoolsViewModel(app: Application) : AndroidViewModel(app) {
    private val repo = SyncRepository(NekoDatabase.get(app))

    val pools: StateFlow<List<PoolEntity>> = repo.poolDao.observeVisible()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    /** Create a new (empty) pool and best-effort sync it home. */
    fun createPool(name: String) {
        val trimmed = name.trim()
        if (trimmed.isBlank()) return
        viewModelScope.launch {
            repo.enqueuePoolUpsert(UUID.randomUUID().toString(), trimmed, null, emptyList())
            SyncManager.sync(getApplication())
            SyncScheduler.requestOneShot(getApplication())
        }
    }

    fun deletePool(uuid: String) {
        viewModelScope.launch {
            repo.enqueuePoolDelete(uuid)
            SyncManager.sync(getApplication())
            SyncScheduler.requestOneShot(getApplication())
        }
    }
}
