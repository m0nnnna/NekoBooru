package com.nekobooru.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudUpload
import androidx.compose.material.icons.filled.PlayCircle
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import coil.request.ImageRequest
import com.nekobooru.app.data.ApiFactory
import com.nekobooru.app.data.MediaPaths
import com.nekobooru.app.data.db.PostEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/** Adaptive thumbnail grid shared by the gallery and the pool view. */
@Composable
fun PostThumbGrid(
    posts: List<PostEntity>,
    serverUrl: String,
    onPostClick: (String) -> Unit,
    contentPadding: PaddingValues = PaddingValues(top = 12.dp),
    state: LazyGridState = rememberLazyGridState(),
) {
    LazyVerticalGrid(
        state = state,
        columns = GridCells.Adaptive(minSize = 110.dp),
        contentPadding = contentPadding,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        items(posts, key = { it.sha256 }, contentType = { "post" }) { post ->
            PostThumb(post, serverUrl, onClick = { onPostClick(post.sha256) })
        }
    }
}

/** A single square thumbnail with video and pending-upload badges. */
@Composable
fun PostThumb(post: PostEntity, serverUrl: String, onClick: () -> Unit) {
    val context = LocalContext.current
    // Prefer local files so the grid works fully offline: the pending media file
    // (not yet synced), then the cached thumbnail (by file existence), then the
    // server thumbnail. The cached-thumbnail check is a filesystem stat, so it
    // runs off the main thread (produceState on IO) to keep fling smooth; the
    // server URL is used until that resolves.
    val serverThumb = remember(serverUrl, post.thumbUrl) {
        ApiFactory.absoluteUrl(serverUrl, post.thumbUrl)
    }
    val model: Any by produceState<Any>(serverThumb, post.sha256, post.localMediaPath, serverThumb) {
        value = withContext(Dispatchers.IO) {
            post.localMediaPath?.let { File(it) }
                ?: MediaPaths.thumb(context, post.sha256).takeIf { it.exists() }
                ?: serverThumb
        }
    }
    Box(
        modifier = Modifier
            .aspectRatio(1f)
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onClick),
    ) {
        AsyncImage(
            model = ImageRequest.Builder(context).data(model).build(),
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
        if (post.dirty) {
            Surface(
                color = MaterialTheme.colorScheme.tertiaryContainer,
                modifier = Modifier.align(Alignment.TopStart).padding(4.dp),
            ) {
                Icon(
                    imageVector = Icons.Filled.CloudUpload,
                    contentDescription = "Pending upload",
                    modifier = Modifier.padding(2.dp),
                )
            }
        }
    }
}
