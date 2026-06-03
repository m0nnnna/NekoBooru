package com.nekobooru.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material.icons.filled.PlayCircle
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import coil.request.ImageRequest
import com.nekobooru.app.data.ApiFactory
import com.nekobooru.app.data.db.PostEntity
import java.io.File

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DetailScreen(vm: DetailViewModel, sha: String, onBack: () -> Unit) {
    LaunchedEffect(sha) { vm.load(sha) }
    val post by vm.post.collectAsStateWithLifecycle()
    var editing by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Post") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { padding ->
        val p = post
        if (p == null) {
            Box(Modifier.fillMaxSize().padding(padding), Alignment.Center) { Text("Loading…") }
            return@Scaffold
        }
        Column(
            modifier = Modifier.fillMaxSize().padding(padding)
                .verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            MediaPreview(p, vm.serverUrl)

            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = vm::toggleFavorite) {
                    Icon(
                        imageVector = if (p.isFavorited) Icons.Filled.Favorite else Icons.Filled.FavoriteBorder,
                        contentDescription = "Favorite",
                        tint = if (p.isFavorited) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                    )
                }
                Text("Safety: ${p.safety}", modifier = Modifier.padding(start = 8.dp))
            }

            if (vm.isPending) {
                Text(
                    "Pending upload — sync before editing.",
                    color = MaterialTheme.colorScheme.tertiary,
                )
            }

            if (editing && !vm.isPending) {
                EditSection(
                    initialTags = p.tags,
                    initialSafety = p.safety,
                    onCancel = { editing = false },
                    onSave = { tags, safety ->
                        vm.saveEdit(tags, safety)
                        editing = false
                    },
                )
            } else {
                Text("Tags", style = MaterialTheme.typography.titleMedium)
                Text(if (p.tags.isBlank()) "(none)" else p.tagList.joinToString(" "))

                if (!vm.isPending) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = { editing = true }) {
                            Icon(Icons.Filled.Edit, contentDescription = null)
                            Text("Edit", modifier = Modifier.padding(start = 6.dp))
                        }
                        Button(
                            onClick = { vm.delete(onBack) },
                            colors = androidx.compose.material3.ButtonDefaults.buttonColors(
                                containerColor = MaterialTheme.colorScheme.error,
                            ),
                        ) {
                            Icon(Icons.Filled.Delete, contentDescription = null)
                            Text("Delete", modifier = Modifier.padding(start = 6.dp))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MediaPreview(post: PostEntity, serverUrl: String) {
    val context = LocalContext.current
    // Full image for pictures; for video show the thumbnail with a play badge
    // (in-app playback arrives with Media3 in a later step).
    val model: Any = when {
        post.localMediaPath != null && !post.isVideo -> File(post.localMediaPath)
        post.isVideo -> post.localMediaPath?.let { File(it) }
            ?: ApiFactory.absoluteUrl(serverUrl, post.thumbUrl)
        else -> ApiFactory.absoluteUrl(serverUrl, post.contentUrl)
    }
    Box(
        modifier = Modifier.fillMaxWidth().aspectRatio(1f).wrapContentHeight(),
        contentAlignment = Alignment.Center,
    ) {
        AsyncImage(
            model = ImageRequest.Builder(context).data(model).crossfade(true).build(),
            contentDescription = post.filename,
            contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxSize(),
        )
        if (post.isVideo) {
            Icon(
                Icons.Filled.PlayCircle, contentDescription = "Video",
                tint = Color.White, modifier = Modifier.align(Alignment.Center),
            )
        }
    }
}

@Composable
private fun EditSection(
    initialTags: String,
    initialSafety: String,
    onCancel: () -> Unit,
    onSave: (String, String) -> Unit,
) {
    var tags by remember { mutableStateOf(initialTags) }
    var safety by remember { mutableStateOf(initialSafety) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = tags,
            onValueChange = { tags = it },
            label = { Text("Tags (space-separated)") },
            modifier = Modifier.fillMaxWidth(),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("safe", "sketchy", "unsafe").forEach { level ->
                FilterChip(
                    selected = safety == level,
                    onClick = { safety = level },
                    label = { Text(level) },
                )
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onCancel) { Text("Cancel") }
            Button(onClick = { onSave(tags, safety) }) { Text("Save") }
        }
    }
}
