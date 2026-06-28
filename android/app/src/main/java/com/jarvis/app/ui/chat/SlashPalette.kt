package com.jarvis.app.ui.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.jarvis.app.protocol.Agent
import com.jarvis.app.protocol.Skill
import com.jarvis.app.ui.theme.JarvisPalette

/** One entry in the "/" palette. [insert] is dropped into the draft when picked. */
private data class SlashEntry(val label: String, val sub: String, val group: String, val insert: String)

/**
 * The Claude-Code-style "/" command menu for the chat composer. Shown ABOVE the
 * input when the draft is a single "/word" token; lists COMMANDS, AGENTS and
 * SKILLS, filtered live, with a slide+fade entrance. Picking drops text into the
 * draft (commands/agents/skills all complete to a "/…" the send handler runs).
 */
@Composable
fun SlashPalette(
    draft: String,
    agents: List<Agent>,
    skills: List<Skill>,
    onPick: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val open = draft.startsWith("/") && !draft.contains(" ")
    val q = if (open) draft.removePrefix("/").lowercase() else ""

    fun matches(vararg hay: String?) = q.isEmpty() || hay.any { it?.lowercase()?.contains(q) == true }

    val results = buildList {
        // built-in commands that work in a chat
        val commands = listOf(
            SlashEntry("/dispatch", "Dispatch an agent: /dispatch <agent> <task>", "COMMANDS", "/dispatch "),
            SlashEntry("/clear", "Clear the message box", "COMMANDS", "/clear"),
        )
        commands.forEach { if (matches(it.label)) add(it) }
        agents.forEach { a ->
            if (matches(a.name, a.whenToUse))
                add(SlashEntry("/dispatch ${a.name}", a.whenToUse ?: a.description ?: "", "AGENTS", "/dispatch ${a.name} "))
        }
        skills.forEach { s ->
            if (matches(s.name))
                add(SlashEntry("/${s.name}", s.description ?: "", "SKILLS", "/${s.name} "))
        }
    }

    AnimatedVisibility(
        visible = open && results.isNotEmpty(),
        enter = slideInVertically(tween(200)) { it / 3 } + fadeIn(tween(180)),
        exit = fadeOut(tween(120)),
        modifier = modifier,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 10.dp)
                .clip(RoundedCornerShape(14.dp))
                .background(JarvisPalette.Surface)
                .border(1.dp, JarvisPalette.AccentDim, RoundedCornerShape(14.dp)),
        ) {
            LazyColumn(Modifier.heightIn(max = 280.dp).padding(6.dp)) {
                items(results) { e ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .clickable { onPick(e.insert) }
                            .padding(horizontal = 10.dp, vertical = 9.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(
                            Modifier
                                .size(26.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .background(
                                    when (e.group) {
                                        "AGENTS" -> JarvisPalette.Violet.copy(alpha = 0.18f)
                                        "SKILLS" -> JarvisPalette.Accent2.copy(alpha = 0.18f)
                                        else -> JarvisPalette.AccentDim.copy(alpha = 0.30f)
                                    },
                                ),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                when (e.group) { "AGENTS" -> "✦"; "SKILLS" -> "⚡"; else -> "›" },
                                color = when (e.group) {
                                    "AGENTS" -> JarvisPalette.Violet
                                    "SKILLS" -> JarvisPalette.Accent2
                                    else -> JarvisPalette.Accent
                                },
                            )
                        }
                        Column(Modifier.weight(1f).padding(start = 11.dp)) {
                            Text(
                                e.label,
                                color = JarvisPalette.TextPrimary,
                                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            if (e.sub.isNotBlank()) {
                                Text(
                                    e.sub,
                                    color = JarvisPalette.TextFaint,
                                    style = MaterialTheme.typography.bodySmall,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                        Text(
                            e.group,
                            color = JarvisPalette.TextFaint,
                            style = MaterialTheme.typography.labelSmall,
                        )
                    }
                }
            }
        }
    }
}
