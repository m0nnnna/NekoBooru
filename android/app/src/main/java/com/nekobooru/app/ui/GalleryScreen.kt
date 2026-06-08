package com.nekobooru.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.text.DateFormat
import java.util.Date

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GalleryScreen(
    vm: GalleryViewModel,
    onAdd: () -> Unit,
    onPostClick: (String, List<String>) -> Unit,
    onOpenPools: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    // Restore the remembered scroll position; persist it when leaving the screen.
    val gridState = rememberLazyGridState(vm.scrollIndex, vm.scrollOffset)
    DisposableEffect(Unit) {
        onDispose {
            vm.scrollIndex = gridState.firstVisibleItemIndex
            vm.scrollOffset = gridState.firstVisibleItemScrollOffset
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    val progress by com.nekobooru.app.data.SyncProgress.state.collectAsStateWithLifecycle()
                    Column {
                        Text("NekoBooru")
                        val subtitle = progress?.let { "${it.phase} ${it.done}/${it.total}" }
                            ?: lastSyncedLabel(state.lastSyncedAt)
                        Text(
                            subtitle,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                actions = {
                    IconButton(onClick = onOpenPools) {
                        Icon(Icons.AutoMirrored.Filled.List, contentDescription = "Pools")
                    }
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Filled.Settings, contentDescription = "Settings")
                    }
                },
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = onAdd) {
                Icon(Icons.Filled.Add, contentDescription = "Add media")
            }
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 12.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value = state.query,
                    onValueChange = vm::onQueryChange,
                    label = { Text("Search tags") },
                    singleLine = true,
                    modifier = Modifier.weight(1f),
                )
                Button(onClick = vm::sync, enabled = !state.loading) {
                    Text("Sync")
                }
            }

            val suggestions by vm.suggestions.collectAsStateWithLifecycle()
            if (suggestions.isNotEmpty()) {
                LazyRow(
                    modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    items(suggestions, key = { it }) { tag ->
                        SuggestionChip(
                            onClick = { vm.applySuggestion(tag) },
                            label = { Text(tag) },
                        )
                    }
                }
            }

            SafetyFilterRow(
                visible = state.visibleSafety,
                onToggle = vm::toggleSafety,
                modifier = Modifier.padding(top = 8.dp),
            )

            when {
                state.loading -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    CircularProgressIndicator()
                }
                state.error != null -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    Text("Error: ${state.error}", color = MaterialTheme.colorScheme.error)
                }
                state.posts.isEmpty() -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    Text("No posts cached. Tap Sync, or add media with +.")
                }
                else -> {
                    val orderedShas = remember(state.posts) { state.posts.map { it.sha256 } }
                    PostThumbGrid(
                        state.posts,
                        vm.serverUrl,
                        onPostClick = { sha -> onPostClick(sha, orderedShas) },
                        state = gridState,
                    )
                }
            }
        }
    }
}

private fun lastSyncedLabel(ts: Long): String {
    if (ts <= 0) return "Never synced"
    val fmt = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT)
    return "Last synced ${fmt.format(Date(ts))}"
}
