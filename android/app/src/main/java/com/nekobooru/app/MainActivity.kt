package com.nekobooru.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.viewmodel.compose.viewModel
import com.nekobooru.app.ui.GalleryScreen
import com.nekobooru.app.ui.GalleryViewModel
import com.nekobooru.app.ui.NekoBooruTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            NekoBooruTheme {
                val vm: GalleryViewModel = viewModel()
                GalleryScreen(vm)
            }
        }
    }
}
