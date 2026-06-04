package com.nekobooru.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView

/**
 * In-app video playback (Media3/ExoPlayer), matching the website's
 * `<video controls autoplay loop>`. [uri] is a local `file://` path when the
 * original is cached, otherwise the streamed server URL.
 */
@Composable
fun VideoPlayer(uri: String, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val player = remember(uri) {
        ExoPlayer.Builder(context).build().apply {
            setMediaItem(MediaItem.fromUri(uri))
            repeatMode = Player.REPEAT_MODE_ALL   // loop
            playWhenReady = true                  // autoplay
            prepare()
        }
    }
    DisposableEffect(uri) {
        onDispose { player.release() }
    }
    AndroidView(
        modifier = modifier,
        factory = { ctx -> PlayerView(ctx).apply { useController = true } },
        // Attach the player in update (after the view is laid out and its surface
        // exists) — assigning it in factory renders a black frame until you leave
        // and re-enter.
        update = { view -> view.player = player },
    )
}
