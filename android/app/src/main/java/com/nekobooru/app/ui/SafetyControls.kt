package com.nekobooru.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/**
 * The website's "traffic light" safety controls: small coloured squares
 * (green / amber / red), dimmed when off and full-opacity when on — no text.
 * Mirrors `.safety-btn` / `.safety-checkbox` in the Vue frontend.
 */
private data class SafetySwatch(val level: String, val color: Color, val label: String)

private val SAFETY_SWATCHES = listOf(
    SafetySwatch("safe", Color(0xFF4ADE80), "Safe"),
    SafetySwatch("sketchy", Color(0xFFFACC15), "Sketchy"),
    SafetySwatch("unsafe", Color(0xFFF87171), "Unsafe"),
)

/** Multi-select toggles (gallery sensitivity filter). */
@Composable
fun SafetyFilterRow(
    visible: Set<String>,
    onToggle: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        SAFETY_SWATCHES.forEach { s ->
            SafetyDot(s, selected = s.level in visible, onClick = { onToggle(s.level) })
        }
    }
}

/** Single-select (new post / edit safety). */
@Composable
fun SafetySelectorRow(
    selected: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        SAFETY_SWATCHES.forEach { s ->
            SafetyDot(s, selected = s.level == selected, onClick = { onSelect(s.level) })
        }
    }
}

@Composable
private fun SafetyDot(swatch: SafetySwatch, selected: Boolean, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .size(44.dp)   // comfortable touch target
            .clickable(onClick = onClick, onClickLabel = swatch.label)
            .semantics { contentDescription = swatch.label },
        contentAlignment = Alignment.Center,
    ) {
        val swatchShape = RoundedCornerShape(6.dp)
        var box = Modifier
            .size(28.dp)
            .clip(swatchShape)
            .alpha(if (selected) 1f else 0.3f)
            .background(swatch.color)
        if (selected) {
            box = box.border(2.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f), swatchShape)
        }
        Box(modifier = box)
    }
}
