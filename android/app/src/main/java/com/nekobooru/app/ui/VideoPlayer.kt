package com.nekobooru.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView

/**
 * In-app video playback (Media3/ExoPlayer), matching the website's
 * `<video controls autoplay loop>`. [uri] is a local `file://`/`content://` path
 * when the original is cached, otherwise the streamed server URL.
 *
 * The controller shows a fullscreen button: tapping it moves the *same* player
 * into a full-screen dialog (and back), so playback continues uninterrupted.
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

    var fullscreen by remember { mutableStateOf(false) }

    if (!fullscreen) {
        PlayerSurface(player, modifier) { fullscreen = true }
    } else {
        Dialog(
            onDismissRequest = { fullscreen = false },
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Box(Modifier.fillMaxSize().background(Color.Black)) {
                PlayerSurface(player, Modifier.fillMaxSize()) { fullscreen = false }
            }
        }
    }
}

/** Hosts [player] in a [PlayerView]; the fullscreen control calls [onToggleFullscreen]. */
@Composable
private fun PlayerSurface(
    player: ExoPlayer,
    modifier: Modifier,
    onToggleFullscreen: () -> Unit,
) {
    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            PlayerView(ctx).apply {
                useController = true
                // Adding a listener makes Media3 render the fullscreen button.
                setFullscreenButtonClickListener { onToggleFullscreen() }
            }
        },
        // Attach the player in update (after the surface exists) to avoid a black
        // first frame, and refresh the listener so it targets this surface's toggle.
        update = { view ->
            view.player = player
            view.setFullscreenButtonClickListener { onToggleFullscreen() }
        },
        // Detach before this surface leaves so the player can re-attach to the other
        // surface (inline <-> fullscreen) without a "player already attached" glitch.
        onRelease = { view -> view.player = null },
    )
}
