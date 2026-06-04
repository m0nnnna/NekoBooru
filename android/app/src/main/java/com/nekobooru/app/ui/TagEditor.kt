package com.nekobooru.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.InputChip
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp

/**
 * Tag input matching the website's: committed tags show as removable pills,
 * pressing space (or Done) turns the typed text into a pill, and matching tags
 * from the library are suggested as you type.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TagEditor(
    tags: List<String>,
    allTags: List<String>,
    onTagsChange: (List<String>) -> Unit,
    modifier: Modifier = Modifier,
    label: String = "Tags",
) {
    var input by remember { mutableStateOf("") }

    fun commit(raw: String) {
        val t = raw.trim().lowercase()
        if (t.isNotEmpty() && t !in tags) onTagsChange(tags + t)
        input = ""
    }

    val suggestions = remember(input, allTags, tags) {
        val term = input.trim().lowercase()
        if (term.isEmpty()) emptyList()
        else allTags.asSequence()
            .filter { it.lowercase().contains(term) && it !in tags }
            .sortedByDescending { it.lowercase().startsWith(term) }
            .take(10).toList()
    }

    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (tags.isNotEmpty()) {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                tags.forEach { tag ->
                    InputChip(
                        selected = false,
                        onClick = { onTagsChange(tags - tag) },
                        label = { Text(tag) },
                        trailingIcon = {
                            Icon(
                                Icons.Filled.Close,
                                contentDescription = "Remove $tag",
                                modifier = Modifier.size(16.dp),
                            )
                        },
                    )
                }
            }
        }
        OutlinedTextField(
            value = input,
            onValueChange = { v -> if (v.endsWith(" ") || v.endsWith("\n")) commit(v) else input = v },
            label = { Text(label) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { commit(input) }),
            modifier = Modifier.fillMaxWidth(),
        )
        if (suggestions.isNotEmpty()) {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                items(suggestions, key = { it }) { tag ->
                    SuggestionChip(onClick = { commit(tag) }, label = { Text(tag) })
                }
            }
        }
    }
}
