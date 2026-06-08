package com.nekobooru.app

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.nekobooru.app.data.AppSettings
import com.nekobooru.app.data.MediaPaths
import com.nekobooru.app.data.RetentionManager
import com.nekobooru.app.data.db.NekoDatabase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
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
    // shas is the ordered list of the view the post was opened from, so Detail
    // can step prev/next through the same filtered, sorted set.
    data class Detail(val sha: String, val shas: List<String> = emptyList()) : Screen
    data object Pools : Screen
    data class Pool(val uuid: String) : Screen
    data object Settings : Screen
}

class MainActivity : ComponentActivity() {
    /**
     * Launched from another app's "attach"/"insert" picker (ACTION_GET_CONTENT or
     * ACTION_PICK): tapping a post returns its media URI to that app instead of
     * opening the detail screen.
     */
    private val pickMode: Boolean
        get() = intent?.action == Intent.ACTION_GET_CONTENT ||
            intent?.action == Intent.ACTION_PICK

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // Default to "canceled" so a back-out hands nothing back to the caller.
        if (pickMode) setResult(RESULT_CANCELED)
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

        // While preparing a picked file (download/redelegate), block taps and
        // show a spinner over the gallery.
        var preparing by remember { mutableStateOf(false) }

        // In pick mode a tap returns the post to the caller; otherwise it opens
        // detail, carrying the current view's ordered shas for prev/next nav.
        val onPostClick: (String, List<String>) -> Unit = { sha, shas ->
            if (pickMode) returnPicked(sha) { preparing = it } else push(Screen.Detail(sha, shas))
        }

        when (val s = stack.last()) {
            Screen.Gallery -> {
                val vm: GalleryViewModel = viewModel()
                GalleryScreen(
                    vm,
                    onAdd = { push(Screen.Add()) },
                    onPostClick = onPostClick,
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
                DetailScreen(
                    vm,
                    sha = s.sha,
                    shas = s.shas,
                    onBack = { pop() },
                    // Replace (not push) so back still returns to the grid/pool
                    // and the stack doesn't grow as you page through posts.
                    onNavigate = { newSha -> stack[stack.lastIndex] = Screen.Detail(newSha, s.shas) },
                )
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
                    onPostClick = onPostClick,
                )
            }
            Screen.Settings -> {
                val vm: SettingsViewModel = viewModel()
                SettingsScreen(vm, onBack = { pop() })
            }
        }

        if (preparing) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
        }
    }

    /**
     * Resolve [sha] to a shareable URI and return it to the calling app. Downloads
     * the original first if it isn't cached (so videos/large files work), reusing
     * the same FileProvider/SAF redelegation as the share sheet.
     */
    private fun returnPicked(sha: String, setPreparing: (Boolean) -> Unit) {
        setPreparing(true)
        lifecycleScope.launch {
            val settings = AppSettings(this@MainActivity)
            val db = NekoDatabase.get(this@MainActivity)
            val post = withContext(Dispatchers.IO) { db.postDao().getBySha(sha) }
            val path = if (sha.startsWith("pending-")) post?.localMediaPath
            else RetentionManager(this@MainActivity).fetchOriginal(settings.serverUrl, sha)
            if (path == null) {
                setPreparing(false)
                Toast.makeText(
                    this@MainActivity,
                    "Couldn't load that media (offline?)",
                    Toast.LENGTH_SHORT,
                ).show()
                return@launch
            }
            // App-private files are served via our FileProvider; a user-folder
            // original is already a content URI we hold a persisted grant for.
            val uri: Uri = if (MediaPaths.isContentUri(path)) Uri.parse(path)
            else FileProvider.getUriForFile(
                this@MainActivity, "$packageName.fileprovider", File(path),
            )
            val mime = mimeForExtension(post?.extension)
            val result = Intent().apply {
                setDataAndType(uri, mime)
                // ClipData carries the grant for apps that read getClipData().
                clipData = ClipData.newUri(contentResolver, post?.filename ?: "media", uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            setResult(RESULT_OK, result)
            finish()
        }
    }

    private fun mimeForExtension(ext: String?): String = when (ext?.lowercase()) {
        ".jpg", ".jpeg" -> "image/jpeg"
        ".png" -> "image/png"
        ".gif" -> "image/gif"
        ".webp" -> "image/webp"
        ".mp4" -> "video/mp4"
        ".webm" -> "video/webm"
        else -> "application/octet-stream"
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
