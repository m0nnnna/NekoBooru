package com.nekobooru.app

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.nekobooru.app.ui.AddScreen
import com.nekobooru.app.ui.AddViewModel
import com.nekobooru.app.ui.AppThemeState
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
            val themeMode by AppThemeState.mode.collectAsStateWithLifecycle()
            NekoBooruTheme(themeMode = themeMode) {
                // A simple navigation back stack: the last entry is the current
                // screen; the system back button pops it (closing the app only at
                // the root). Detail reached from a pool returns to that pool.
                val stack = remember {
                    mutableStateListOf<Screen>(Screen.Gallery).also {
                        if (shared != null) it.add(Screen.Add(shared))
                    }
                }
                AppNav(stack)
            }
        }
    }

    @Composable
    private fun AppNav(stack: SnapshotStateList<Screen>) {
        fun push(screen: Screen) { stack.add(screen) }
        fun pop() { if (stack.size > 1) stack.removeAt(stack.lastIndex) }

        // Hardware/gesture back pops the stack instead of finishing the activity.
        BackHandler(enabled = stack.size > 1) { pop() }

        when (val s = stack.last()) {
            Screen.Gallery -> {
                val vm: GalleryViewModel = viewModel()
                GalleryScreen(
                    vm,
                    onAdd = { push(Screen.Add()) },
                    onPostClick = { sha -> push(Screen.Detail(sha)) },
                    onOpenPools = { push(Screen.Pools) },
                    onOpenSettings = { push(Screen.Settings) },
                )
            }
            is Screen.Add -> {
                val vm: AddViewModel = viewModel()
                AddScreen(vm, sharedUri = s.sharedUri, onDone = { pop() })
            }
            is Screen.Detail -> {
                val vm: DetailViewModel = viewModel()
                DetailScreen(vm, sha = s.sha, onBack = { pop() })
            }
            Screen.Pools -> {
                val vm: PoolsViewModel = viewModel()
                PoolsScreen(
                    vm,
                    onBack = { pop() },
                    onPoolClick = { uuid -> push(Screen.Pool(uuid)) },
                )
            }
            is Screen.Pool -> {
                val vm: PoolViewModel = viewModel()
                PoolScreen(
                    vm,
                    uuid = s.uuid,
                    onBack = { pop() },
                    onPostClick = { sha -> push(Screen.Detail(sha)) },
                )
            }
            Screen.Settings -> {
                val vm: SettingsViewModel = viewModel()
                SettingsScreen(vm, onBack = { pop() })
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
