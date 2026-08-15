package com.pocketagent.app.ui.components

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.pocketagent.app.ui.theme.MonoMedium

/**
 * Minimal, dependency-free markdown renderer for agent replies.
 * Supports: fenced code blocks (with copy), headings, bullets/numbered
 * lists, blockquotes, bold, italic, inline code. Unknown syntax passes
 * through untouched — the agent is the author, we are the paper.
 */
@Composable
fun MarkdownText(text: String, modifier: Modifier = Modifier) {
    Column(modifier = modifier) {
        val blocks = splitBlocks(text)
        blocks.forEachIndexed { index, block ->
            when (block) {
                is Block.Code -> CodeBlock(block)
                is Block.Heading -> Text(
                    text = block.text,
                    style = when (block.level) {
                        1 -> MaterialTheme.typography.titleLarge
                        2 -> MaterialTheme.typography.titleMedium
                        else -> MaterialTheme.typography.titleSmall
                    },
                    modifier = Modifier.padding(top = if (index == 0) 0.dp else 8.dp, bottom = 3.dp),
                )
                is Block.ListItem -> Row(modifier = Modifier.padding(start = 2.dp, top = 3.dp, bottom = 3.dp)) {
                    Text(
                        text = block.marker,
                        style = MaterialTheme.typography.bodyMedium,
                        // Grey: a bullet is punctuation, not an accent.
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.width(20.dp),
                    )
                    Text(
                        text = inlineStyled(block.content),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                is Block.Quote -> Box(
                    modifier = Modifier
                        .padding(vertical = 4.dp)
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp))
                        .padding(10.dp),
                ) {
                    Text(
                        text = inlineStyled(block.content),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                is Block.Paragraph -> Text(
                    text = inlineStyled(block.content),
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(vertical = 3.dp),
                )
            }
        }
    }
}

private sealed interface Block {
    data class Paragraph(val content: String) : Block
    data class Heading(val level: Int, val text: String) : Block
    data class ListItem(val marker: String, val content: String) : Block
    data class Quote(val content: String) : Block
    data class Code(val language: String?, val content: String) : Block
}

private fun splitBlocks(text: String): List<Block> {
    val blocks = mutableListOf<Block>()
    val lines = text.lines()
    var i = 0
    val paragraph = StringBuilder()

    fun flushParagraph() {
        val trimmed = paragraph.toString().trim()
        if (trimmed.isNotEmpty()) blocks += Block.Paragraph(trimmed)
        paragraph.clear()
    }

    while (i < lines.size) {
        val line = lines[i]

        when {
            line.trimStart().startsWith("```") -> {
                flushParagraph()
                val lang = line.trimStart().removePrefix("```").trim().ifEmpty { null }
                val code = StringBuilder()
                i++
                while (i < lines.size && !lines[i].trimStart().startsWith("```")) {
                    code.appendLine(lines[i])
                    i++
                }
                blocks += Block.Code(lang, code.toString().trimEnd())
            }

            Regex("^(#{1,4})\\s+(.*)").find(line)?.let { m ->
                flushParagraph()
                blocks += Block.Heading(m.groupValues[1].length, m.groupValues[2])
            } != null -> Unit

            Regex("^\\s*[-*•]\\s+(.*)").find(line)?.let { m ->
                flushParagraph()
                blocks += Block.ListItem("•", m.groupValues[1])
            } != null -> Unit

            Regex("^\\s*(\\d+)[.)]\\s+(.*)").find(line)?.let { m ->
                flushParagraph()
                blocks += Block.ListItem("${m.groupValues[1]}.", m.groupValues[2])
            } != null -> Unit

            Regex("^\\s*>\\s?(.*)").find(line)?.let { m ->
                flushParagraph()
                blocks += Block.Quote(m.groupValues[1])
            } != null -> Unit

            line.isBlank() -> flushParagraph()

            else -> {
                if (paragraph.isNotEmpty()) paragraph.append('\n')
                paragraph.append(line)
            }
        }
        i++
    }
    flushParagraph()
    return blocks
}

private val BoldItalic = Regex("""(\*\*\*|___)(.+?)\1""")
private val Bold = Regex("""(\*\*|__)(.+?)\1""")
private val Italic = Regex("""(?<!\*)(\*|_)([^*\n]+?)\1(?!\*)""")
private val InlineCode = Regex("""`([^`\n]+)`""")

@Composable
private fun inlineStyled(raw: String): AnnotatedString = buildAnnotatedString {
    var cursor = 0
    InlineCode.findAll(raw).forEach { m ->
        if (m.range.first > cursor) appendMarkup(raw.substring(cursor, m.range.first))
        pushStyle(
            SpanStyle(
                fontFamily = FontFamily.Monospace,
                fontSize = MaterialTheme.typography.bodyMedium.fontSize * 0.92f,
                background = MaterialTheme.colorScheme.surfaceVariant,
            )
        )
        append(m.groupValues[1])
        pop()
        cursor = m.range.last + 1
    }
    if (cursor < raw.length) appendMarkup(raw.substring(cursor))
}

/** Sequential matcher: bold-italic wins over bold over italic. */
private fun AnnotatedString.Builder.appendMarkup(segment: String) {
    appendRuns(segment, BoldItalic, SpanStyle(fontWeight = FontWeight.Bold, fontStyle = androidx.compose.ui.text.font.FontStyle.Italic))
}

private fun AnnotatedString.Builder.appendRuns(
    segment: String,
    top: Regex,
    topStyle: SpanStyle,
) {
    var last = 0
    top.findAll(segment).forEach { m ->
        if (m.range.first > last) appendTail(segment.substring(last, m.range.first))
        pushStyle(topStyle)
        val inner = m.groupValues.last()
        when (top) {
            BoldItalic -> appendRuns(inner, Bold, SpanStyle(fontWeight = FontWeight.Bold))
            Bold -> appendRuns(inner, Italic, SpanStyle(fontStyle = androidx.compose.ui.text.font.FontStyle.Italic))
            else -> append(inner)
        }
        pop()
        last = m.range.last + 1
    }
    if (last < segment.length) appendTail(segment.substring(last))
}

private fun AnnotatedString.Builder.appendTail(segment: String) {
    appendRuns(segment, BoldItalic, SpanStyle(fontWeight = FontWeight.Bold, fontStyle = androidx.compose.ui.text.font.FontStyle.Italic))
}

@Composable
private fun CodeBlock(block: Block.Code) {
    val context = LocalContext.current
    Column(
        modifier = Modifier
            .padding(vertical = 6.dp)
            .fillMaxWidth()
            // Highest, not High: in light mode High is white — the same
            // color as the bubble the code block sits in.
            .background(MaterialTheme.colorScheme.surfaceContainerHighest, RoundedCornerShape(12.dp)),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 12.dp, end = 2.dp, top = 2.dp),
        ) {
            Text(
                text = block.language ?: "code",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            IconButton(onClick = { copy(context, block.content) }) {
                Icon(
                    Icons.Outlined.ContentCopy,
                    contentDescription = "Kopieren",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.height(18.dp).width(18.dp),
                )
            }
        }
        Text(
            text = block.content,
            style = MonoMedium.copy(color = MaterialTheme.colorScheme.onSurface),
            modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 10.dp),
        )
    }
}

private fun copy(context: Context, value: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("code", value))
}
