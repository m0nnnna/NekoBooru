package com.nekobooru.app.ui

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import com.nekobooru.app.data.ThemeMode
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * Process-wide theme mode so the Settings toggle takes effect immediately
 * (mirrors the website's light/dark switch). Seeded from AppSettings on startup.
 */
object AppThemeState {
    val mode = MutableStateFlow(ThemeMode.SYSTEM)
}

// Palette ported from the website's CSS variables (frontend/src/App.vue).
private val LightColors = lightColorScheme(
    primary = Color(0xFF5C9ECE),          // --accent
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFD6E7F4), // --accent-soft-ish
    onPrimaryContainer = Color(0xFF1B3A4D),
    secondary = Color(0xFFE07A5F),        // --coral
    onSecondary = Color(0xFFFFFFFF),
    tertiary = Color(0xFF81B29A),         // --success
    onTertiary = Color(0xFFFFFFFF),
    tertiaryContainer = Color(0xFFD7E8DF),
    onTertiaryContainer = Color(0xFF1E3A2E),
    background = Color(0xFFE8E4DF),        // --bg-body
    onBackground = Color(0xFF2D2A26),     // --text-primary
    surface = Color(0xFFF5F2ED),          // --bg-primary
    onSurface = Color(0xFF2D2A26),
    surfaceVariant = Color(0xFFEAE7E2),   // --bg-secondary
    onSurfaceVariant = Color(0xFF6B6560), // --text-secondary
    error = Color(0xFFC9664A),            // --coral-hover
    onError = Color(0xFFFFFFFF),
    outline = Color(0xFFD4D0CA),          // --border
    outlineVariant = Color(0xFFE8E4DF),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF6AADDE),          // --accent (dark)
    onPrimary = Color(0xFF0E2230),
    primaryContainer = Color(0xFF20425A),
    onPrimaryContainer = Color(0xFFCDE5F7),
    secondary = Color(0xFFEB8B72),        // --coral (dark)
    onSecondary = Color(0xFF3A150C),
    tertiary = Color(0xFF8FC4AA),         // --success (dark)
    onTertiary = Color(0xFF0F2A1E),
    tertiaryContainer = Color(0xFF2A4A3A),
    onTertiaryContainer = Color(0xFFCDEBDB),
    background = Color(0xFF121417),       // --bg-body (dark)
    onBackground = Color(0xFFE4E2DF),     // --text-primary (dark)
    surface = Color(0xFF1A1D21),          // --bg-primary (dark)
    onSurface = Color(0xFFE4E2DF),
    surfaceVariant = Color(0xFF22262B),   // --bg-secondary (dark)
    onSurfaceVariant = Color(0xFFA09A92), // --text-secondary (dark)
    error = Color(0xFFEB8B72),
    onError = Color(0xFF3A150C),
    outline = Color(0xFF3A3F47),          // --border (dark)
    outlineVariant = Color(0xFF2C3138),
)

@Composable
fun NekoBooruTheme(
    themeMode: ThemeMode = ThemeMode.SYSTEM,
    content: @Composable () -> Unit,
) {
    val dark = when (themeMode) {
        ThemeMode.SYSTEM -> isSystemInDarkTheme()
        ThemeMode.LIGHT -> false
        ThemeMode.DARK -> true
    }
    val colors = if (dark) DarkColors else LightColors

    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            window.statusBarColor = colors.background.toArgb()
            WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = !dark
        }
    }

    MaterialTheme(colorScheme = colors, content = content)
}
