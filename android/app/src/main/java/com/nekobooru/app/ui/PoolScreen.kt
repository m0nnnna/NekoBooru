package com.nekobooru.app.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PoolScreen(
    vm: PoolViewModel,
    uuid: String,
    onBack: () -> Unit,
    onPostClick: (String) -> Unit,
) {
    LaunchedEffect(uuid) { vm.load(uuid) }
    val state by vm.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(state.name.ifBlank { "Pool" }) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { padding ->
        if (state.posts.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(padding), Alignment.Center) {
                Text("This pool has no posts yet. Add some from a post's detail screen.")
            }
        } else {
            Box(Modifier.fillMaxSize().padding(padding).padding(horizontal = 12.dp)) {
                PostThumbGrid(
                    posts = state.posts,
                    serverUrl = vm.serverUrl,
                    onPostClick = onPostClick,
                    contentPadding = PaddingValues(vertical = 12.dp),
                )
            }
        }
    }
}
