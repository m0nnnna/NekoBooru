package com.nekobooru.app

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
import com.nekobooru.app.ui.GalleryScreen
import com.nekobooru.app.ui.GalleryViewModel
import com.nekobooru.app.ui.NekoBooruTheme

private enum class Screen { Gallery, Add }

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            NekoBooruTheme {
                var screen by remember { mutableStateOf(Screen.Gallery) }
                when (screen) {
                    Screen.Gallery -> {
                        val vm: GalleryViewModel = viewModel()
                        GalleryScreen(vm, onAdd = { screen = Screen.Add })
                    }
                    Screen.Add -> {
                        val vm: AddViewModel = viewModel()
                        AddScreen(vm, onDone = { screen = Screen.Gallery })
                    }
                }
            }
        }
    }
}
