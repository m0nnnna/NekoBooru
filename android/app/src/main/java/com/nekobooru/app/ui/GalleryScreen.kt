package com.nekobooru.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayCircle
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import coil.request.ImageRequest
import androidx.compose.ui.platform.LocalContext
import com.nekobooru.app.data.ApiFactory
import com.nekobooru.app.data.PostDto

@Composable
fun GalleryScreen(vm: GalleryViewModel) {
    val state by vm.state.collectAsStateWithLifecycle()

    Scaffold { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding).padding(12.dp)) {
            OutlinedTextField(
                value = state.serverUrl,
                onValueChange = vm::onServerUrlChange,
                label = { Text("Server URL") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
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
                Button(onClick = vm::refresh, enabled = !state.loading) {
                    Text("Load")
                }
            }

            when {
                state.loading -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    CircularProgressIndicator()
                }
                state.error != null -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    Text(
                        "Error: ${state.error}",
                        color = MaterialTheme.colorScheme.error,
                    )
                }
                state.posts.isEmpty() -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    Text("No posts. Enter your server URL and tap Load.")
                }
                else -> PostGrid(state.posts, state.serverUrl)
            }
        }
    }
}

@Composable
private fun PostGrid(posts: List<PostDto>, serverUrl: String) {
    LazyVerticalGrid(
        columns = GridCells.Adaptive(minSize = 110.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(top = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        items(posts, key = { it.sha256 }) { post ->
            PostThumb(post, serverUrl)
        }
    }
}

@Composable
private fun PostThumb(post: PostDto, serverUrl: String) {
    val context = LocalContext.current
    Box(
        modifier = Modifier
            .aspectRatio(1f)
            .clip(RoundedCornerShape(8.dp)),
    ) {
        AsyncImage(
            model = ImageRequest.Builder(context)
                .data(ApiFactory.absoluteUrl(serverUrl, post.thumbUrl))
                .crossfade(true)
                .build(),
            contentDescription = post.filename,
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize(),
        )
        if (post.isVideo) {
            Icon(
                imageVector = Icons.Filled.PlayCircle,
                contentDescription = "Video",
                tint = Color.White,
                modifier = Modifier.align(Alignment.Center),
            )
        }
    }
}
