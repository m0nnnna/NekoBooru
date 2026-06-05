package com.nekobooru.app.ui

import android.Manifest
import android.content.Intent
import android.os.Build
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
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
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import coil.request.ImageRequest
import com.nekobooru.app.data.ApiFactory
import com.nekobooru.app.data.MediaPaths
import com.nekobooru.app.data.db.PoolEntity
import com.nekobooru.app.data.db.PostEntity
import java.io.File

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DetailScreen(vm: DetailViewModel, sha: String, onBack: () -> Unit) {
    LaunchedEffect(sha) { vm.load(sha) }
    val post by vm.post.collectAsStateWithLifecycle()
    val pools by vm.pools.collectAsStateWithLifecycle()
    val localOriginal by vm.localOriginal.collectAsStateWithLifecycle()
    val sharing by vm.sharing.collectAsStateWithLifecycle()
    val shareData by vm.shareEvent.collectAsStateWithLifecycle()
    val savingToDevice by vm.savingToDevice.collectAsStateWithLifecycle()
    val saveResult by vm.saveResult.collectAsStateWithLifecycle()
    var editing by remember { mutableStateOf(false) }
    var addingToPool by remember { mutableStateOf(false) }
    var fullscreen by remember { mutableStateOf(false) }

    // Keep the screen awake while viewing a post (esp. video playback).
    val view = LocalView.current
    DisposableEffect(Unit) {
        view.keepScreenOn = true
        onDispose { view.keepScreenOn = false }
    }

    // Hand a prepared file to the system share sheet, then clear the event.
    val context = LocalContext.current
    LaunchedEffect(shareData) {
        val data = shareData ?: return@LaunchedEffect
        runCatching {
            // A user-folder original is already a shareable content URI; an
            // app-private file must be exposed through our FileProvider.
            val uri = if (MediaPaths.isContentUri(data.path)) android.net.Uri.parse(data.path)
            else FileProvider.getUriForFile(
                context, "${context.packageName}.fileprovider", File(data.path),
            )
            val send = Intent(Intent.ACTION_SEND).apply {
                type = data.mime
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(Intent.createChooser(send, "Share via"))
        }
        vm.clearShare()
    }

    // "Save to device": API 29+ needs no permission (scoped MediaStore); older
    // versions must grant WRITE_EXTERNAL_STORAGE first.
    val writePerm = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) vm.saveToDevice()
        else Toast.makeText(context, "Storage permission needed to save", Toast.LENGTH_SHORT).show()
    }
    val requestSave = {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) vm.saveToDevice()
        else writePerm.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
    }
    LaunchedEffect(saveResult) {
        val r = saveResult ?: return@LaunchedEffect
        Toast.makeText(
            context,
            if (r) "Saved to device gallery" else "Couldn't save to device",
            Toast.LENGTH_SHORT,
        ).show()
        vm.clearSaveResult()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Post") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    if (savingToDevice) {
                        CircularProgressIndicator(
                            modifier = Modifier.padding(end = 12.dp).size(22.dp),
                            strokeWidth = 2.dp,
                        )
                    } else {
                        IconButton(onClick = { requestSave() }) {
                            Icon(Icons.Filled.Download, contentDescription = "Save to device")
                        }
                    }
                    if (sharing) {
                        CircularProgressIndicator(
                            modifier = Modifier.padding(end = 12.dp).size(22.dp),
                            strokeWidth = 2.dp,
                        )
                    } else {
                        IconButton(onClick = vm::share) {
                            Icon(Icons.Filled.Share, contentDescription = "Share / export")
                        }
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
            MediaPreview(p, vm.serverUrl, localOriginal, onImageClick = { fullscreen = true })

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
                val allTags by vm.allTags.collectAsStateWithLifecycle()
                EditSection(
                    initialTags = p.tagList,
                    initialSafety = p.safety,
                    allTags = allTags,
                    onCancel = { editing = false },
                    onSave = { tags, safety ->
                        vm.saveEdit(tags.joinToString(" "), safety)
                        editing = false
                    },
                )
            } else {
                Text("Tags", style = MaterialTheme.typography.titleMedium)
                if (p.tags.isBlank()) Text("(none)") else TagPills(p.tagList)

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
                    OutlinedButton(onClick = { addingToPool = true }) {
                        Icon(Icons.Filled.Add, contentDescription = null)
                        Text("Add to pool", modifier = Modifier.padding(start = 6.dp))
                    }
                }
            }
        }
    }

    if (addingToPool) {
        AddToPoolDialog(
            pools = pools,
            onDismiss = { addingToPool = false },
            onPick = { uuid -> vm.addToPool(uuid); addingToPool = false },
            onCreate = { name -> vm.addToNewPool(name); addingToPool = false },
        )
    }

    // Fullscreen, zoomable view of the image at actual size.
    val p = post
    if (fullscreen && p != null && !p.isVideo) {
        Dialog(
            onDismissRequest = { fullscreen = false },
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Box(Modifier.fillMaxSize().background(Color.Black)) {
                ZoomableImage(
                    model = fullImageModel(context, p, vm.serverUrl, localOriginal),
                    modifier = Modifier.fillMaxSize(),
                )
                IconButton(
                    onClick = { fullscreen = false },
                    modifier = Modifier.align(Alignment.TopStart).padding(8.dp),
                ) {
                    Icon(
                        Icons.Filled.Close,
                        contentDescription = "Close",
                        tint = Color.White,
                    )
                }
            }
        }
    }
}

@Composable
private fun AddToPoolDialog(
    pools: List<PoolEntity>,
    onDismiss: () -> Unit,
    onPick: (String) -> Unit,
    onCreate: (String) -> Unit,
) {
    var newName by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Add to pool") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (pools.isEmpty()) {
                    Text("No pools yet — create one below.")
                } else {
                    pools.forEach { pool ->
                        Text(
                            pool.name,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { onPick(pool.uuid) }
                                .padding(vertical = 8.dp),
                        )
                    }
                    HorizontalDivider()
                }
                OutlinedTextField(
                    value = newName,
                    onValueChange = { newName = it },
                    label = { Text("New pool name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onCreate(newName) },
                enabled = newName.isNotBlank(),
            ) { Text("Create & add") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun MediaPreview(
    post: PostEntity,
    serverUrl: String,
    localOriginal: String?,
    onImageClick: () -> Unit,
) {
    val context = LocalContext.current

    // Video: play in-app (Media3), like the website. Use the cached original
    // (offline) when present, otherwise stream from the server.
    if (post.isVideo) {
        // Play the cached original if the offline mirror has it; otherwise stream.
        val videoUri = post.localOriginalPath?.let { MediaPaths.toUri(it).toString() }
            ?: post.localMediaPath?.let { android.net.Uri.fromFile(File(it)).toString() }
            ?: ApiFactory.absoluteUrl(serverUrl, post.contentUrl)
        VideoPlayer(
            uri = videoUri,
            modifier = Modifier.fillMaxWidth().aspectRatio(1f),
        )
        return
    }

    val model = imageModel(context, post, serverUrl, localOriginal)
    Box(
        modifier = Modifier.fillMaxWidth().aspectRatio(1f).wrapContentHeight()
            .clickable { onImageClick() },
        contentAlignment = Alignment.Center,
    ) {
        AsyncImage(
            model = ImageRequest.Builder(context).data(model).build(),
            contentDescription = post.filename,
            contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxSize(),
        )
    }
}

/**
 * Best available image source: a pending local file, then the cached original
 * (file or content URI), then the cached thumbnail (offline), then the server.
 */
private fun imageModel(
    context: android.content.Context,
    post: PostEntity,
    serverUrl: String,
    localOriginal: String?,
): Any {
    val cachedOriginal: Any? = localOriginal?.let { MediaPaths.toUri(it) }
    val localThumb = MediaPaths.thumb(context, post.sha256).takeIf { it.exists() }
    return when {
        post.localMediaPath != null -> File(post.localMediaPath)
        cachedOriginal != null -> cachedOriginal
        localThumb != null -> localThumb
        else -> ApiFactory.absoluteUrl(serverUrl, post.contentUrl)
    }
}

/** Full-resolution source for the lightbox: skips the thumbnail fallback so zoom
 *  shows real detail (loads the server original if it isn't cached locally). */
private fun fullImageModel(
    context: android.content.Context,
    post: PostEntity,
    serverUrl: String,
    localOriginal: String?,
): Any = when {
    post.localMediaPath != null -> File(post.localMediaPath)
    localOriginal != null -> MediaPaths.toUri(localOriginal)
    else -> ApiFactory.absoluteUrl(serverUrl, post.contentUrl)
}

@Composable
private fun EditSection(
    initialTags: List<String>,
    initialSafety: String,
    allTags: List<String>,
    onCancel: () -> Unit,
    onSave: (List<String>, String) -> Unit,
) {
    var tags by remember { mutableStateOf(initialTags) }
    var safety by remember { mutableStateOf(initialSafety) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        TagEditor(
            tags = tags,
            allTags = allTags,
            onTagsChange = { tags = it },
            modifier = Modifier.fillMaxWidth(),
        )
        SafetySelectorRow(selected = safety, onSelect = { safety = it })
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onCancel) { Text("Cancel") }
            Button(onClick = { onSave(tags, safety) }) { Text("Save") }
        }
    }
}
