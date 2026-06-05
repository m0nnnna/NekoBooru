package com.nekobooru.app.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage

@Composable
fun AddScreen(vm: AddViewModel, onDone: () -> Unit, sharedUri: Uri? = null) {
    val state by vm.state.collectAsStateWithLifecycle()

    // Pre-fill from a "Share to NekoBooru" intent, once.
    LaunchedEffect(sharedUri) {
        if (sharedUri != null) vm.onPicked(sharedUri)
    }

    LaunchedEffect(state.done) {
        if (state.done) {
            onDone()
            vm.reset()
        }
    }

    val picker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia(),
    ) { uri -> if (uri != null) vm.onPicked(uri) }

    Scaffold { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Add media", style = MaterialTheme.typography.titleLarge)

            Box(
                modifier = Modifier.fillMaxWidth().aspectRatio(1.4f)
                    .clip(RoundedCornerShape(12.dp)),
                contentAlignment = Alignment.Center,
            ) {
                if (state.pickedUri != null) {
                    AsyncImage(
                        model = state.pickedUri,
                        contentDescription = "Selected media",
                        contentScale = ContentScale.Fit,
                        modifier = Modifier.fillMaxSize(),
                    )
                } else {
                    OutlinedButton(onClick = {
                        picker.launch(
                            PickVisualMediaRequest(
                                ActivityResultContracts.PickVisualMedia.ImageAndVideo,
                            )
                        )
                    }) { Text("Choose image or video") }
                }
            }

            if (state.pickedUri != null) {
                OutlinedButton(
                    onClick = {
                        picker.launch(
                            PickVisualMediaRequest(
                                ActivityResultContracts.PickVisualMedia.ImageAndVideo,
                            )
                        )
                    },
                ) { Text("Change selection") }
            }

            // ── Or paste a link the server downloads (images, video sites, fediverse). ──
            HorizontalDivider()
            Text("Or paste a link", style = MaterialTheme.typography.titleSmall)

            val clipboard = LocalClipboardManager.current
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value = state.url,
                    onValueChange = vm::onUrlChange,
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                    label = { Text("Image or video link") },
                    enabled = !state.fetching && !state.saving,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                )
                OutlinedButton(
                    onClick = { clipboard.getText()?.text?.let { vm.onUrlChange(it.trim()) } },
                    enabled = !state.fetching && !state.saving,
                ) { Text("Paste") }
            }
            Text(
                "X, YouTube, TikTok, Reddit, etc. + Pleroma/Misskey posts + direct image links. " +
                    "The server fetches it (using its saved cookies for video sites).",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Button(
                onClick = vm::submitUrl,
                enabled = !state.fetching && !state.saving && state.urlSupported,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (state.fetching) {
                    CircularProgressIndicator(
                        modifier = Modifier.padding(end = 8.dp),
                        strokeWidth = 2.dp,
                    )
                }
                Text(if (state.fetching) "Fetching…" else "Fetch & add from link")
            }
            HorizontalDivider()

            val allTags by vm.allTags.collectAsStateWithLifecycle()
            TagEditor(
                tags = state.tags,
                allTags = allTags,
                onTagsChange = vm::onTagsChange,
                modifier = Modifier.fillMaxWidth(),
            )

            SafetySelectorRow(selected = state.safety, onSelect = vm::onSafetyChange)

            if (state.error != null) {
                Text(
                    "Error: ${state.error}",
                    color = MaterialTheme.colorScheme.error,
                )
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedButton(onClick = onDone, enabled = !state.saving && !state.fetching) {
                    Text("Cancel")
                }
                Button(
                    onClick = vm::save,
                    enabled = !state.saving && !state.fetching && state.pickedUri != null,
                ) {
                    if (state.saving) {
                        CircularProgressIndicator(
                            modifier = Modifier.padding(end = 8.dp),
                            strokeWidth = 2.dp,
                        )
                    }
                    Text("Add & sync")
                }
            }
        }
    }
}
