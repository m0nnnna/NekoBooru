package com.nekobooru.app

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.viewmodel.compose.viewModel
import com.nekobooru.app.ui.AddScreen
import com.nekobooru.app.ui.AddViewModel
import com.nekobooru.app.ui.DetailScreen
import com.nekobooru.app.ui.DetailViewModel
import com.nekobooru.app.ui.GalleryScreen
import com.nekobooru.app.ui.GalleryViewModel
import com.nekobooru.app.ui.NekoBooruTheme
import com.nekobooru.app.ui.PoolScreen
import com.nekobooru.app.ui.PoolViewModel
import com.nekobooru.app.ui.PoolsScreen
import com.nekobooru.app.ui.PoolsViewModel
import com.nekobooru.app.ui.SettingsScreen
import com.nekobooru.app.ui.SettingsViewModel

private sealed interface Screen {
    data object Gallery : Screen
    data class Add(val sharedUri: Uri? = null) : Screen
    data class Detail(val sha: String) : Screen
    data object Pools : Screen
    data class Pool(val uuid: String) : Screen
    data object Settings : Screen
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val shared = extractSharedUri(intent)
        setContent {
            NekoBooruTheme {
                // If launched via "Share to NekoBooru", open the Add flow pre-filled.
                var screen by remember {
                    mutableStateOf<Screen>(if (shared != null) Screen.Add(shared) else Screen.Gallery)
                }
                when (val s = screen) {
                    Screen.Gallery -> {
                        val vm: GalleryViewModel = viewModel()
                        GalleryScreen(
                            vm,
                            onAdd = { screen = Screen.Add() },
                            onPostClick = { sha -> screen = Screen.Detail(sha) },
                            onOpenPools = { screen = Screen.Pools },
                            onOpenSettings = { screen = Screen.Settings },
                        )
                    }
                    is Screen.Add -> {
                        val vm: AddViewModel = viewModel()
                        AddScreen(
                            vm,
                            sharedUri = s.sharedUri,
                            onDone = { screen = Screen.Gallery },
                        )
                    }
                    is Screen.Detail -> {
                        val vm: DetailViewModel = viewModel()
                        DetailScreen(vm, sha = s.sha, onBack = { screen = Screen.Gallery })
                    }
                    Screen.Pools -> {
                        val vm: PoolsViewModel = viewModel()
                        PoolsScreen(
                            vm,
                            onBack = { screen = Screen.Gallery },
                            onPoolClick = { uuid -> screen = Screen.Pool(uuid) },
                        )
                    }
                    is Screen.Pool -> {
                        val vm: PoolViewModel = viewModel()
                        PoolScreen(
                            vm,
                            uuid = s.uuid,
                            onBack = { screen = Screen.Pools },
                            onPostClick = { sha -> screen = Screen.Detail(sha) },
                        )
                    }
                    Screen.Settings -> {
                        val vm: SettingsViewModel = viewModel()
                        SettingsScreen(vm, onBack = { screen = Screen.Gallery })
                    }
                }
            }
        }
    }

    /** Pull the shared media Uri out of an ACTION_SEND intent, if any. */
    private fun extractSharedUri(intent: Intent?): Uri? {
        if (intent?.action != Intent.ACTION_SEND) return null
        val type = intent.type ?: return null
        if (!type.startsWith("image/") && !type.startsWith("video/")) return null
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(Intent.EXTRA_STREAM)
        }
    }
}
