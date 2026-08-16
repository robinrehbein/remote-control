package com.pocketagent.app

import com.pocketagent.app.data.ModelInfo
import com.pocketagent.app.ui.screens.filterModels
import com.pocketagent.app.ui.screens.modelMatchesQuery
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelFilterTest {

    private val models = listOf(
        ModelInfo(id = "zai/glm-5-turbo", name = "zai · GLM-5 Turbo"),
        ModelInfo(id = "zai/glm-5.2"),
        ModelInfo(id = "zai/glm-5.2-highspeed", name = "zai · GLM-5.2 Highspeed"),
        ModelInfo(id = "zai/glm-5.3", name = "zai · GLM-5.3"),
        ModelInfo(id = "zai-coding-cn/glm-4.7", name = "zai coding cn · GLM-4.7"),
        ModelInfo(id = "zai-coding-cn/glm-5-turbo", name = "zai coding cn · GLM-5 Turbo"),
        ModelInfo(id = "anthropic/claude-opus-5", name = "Claude Opus 5"),
    )

    @Test
    fun `empty query keeps every model`() {
        assertEquals(models, filterModels(models, ""))
        assertEquals(models, filterModels(models, "   "))
    }

    @Test
    fun `query is trimmed before matching`() {
        assertEquals(listOf(models[3]), filterModels(models, "  glm-5.3  "))
        assertTrue(modelMatchesQuery(models[3], "\tglm-5.3\n"))
    }

    @Test
    fun `matches on the id even when the display name hides it`() {
        // „5.3“ steht so nur in der Id-Schreibweise des Eintrags.
        val hit = filterModels(models, "5.3")
        assertEquals(listOf("zai/glm-5.3"), hit.map { it.id })
    }

    @Test
    fun `matches on the display name`() {
        assertTrue(modelMatchesQuery(models[6], "claude opus"))
        assertEquals(listOf("anthropic/claude-opus-5"), filterModels(models, "Claude Opus").map { it.id })
    }

    @Test
    fun `matching ignores case in both directions`() {
        assertTrue(modelMatchesQuery(models[0], "GLM-5-TURBO"))
        assertTrue(modelMatchesQuery(models[0], "glm-5-turbo"))
        assertTrue(modelMatchesQuery(models[6], "CLAUDE"))
        assertEquals(2, filterModels(models, "TURBO").size)
    }

    @Test
    fun `substring of a provider prefix finds its whole family`() {
        val hits = filterModels(models, "coding")
        assertEquals(listOf("zai-coding-cn/glm-4.7", "zai-coding-cn/glm-5-turbo"), hits.map { it.id })
    }

    @Test
    fun `a model without a name is matched through its id only`() {
        val nameless = models[1]
        assertTrue(modelMatchesQuery(nameless, "glm-5.2"))
        assertFalse(modelMatchesQuery(nameless, "highspeed"))
    }

    @Test
    fun `no hit yields an empty list and keeps the order otherwise`() {
        assertTrue(filterModels(models, "gpt").isEmpty())
        assertEquals(
            listOf("zai/glm-5.2", "zai/glm-5.2-highspeed"),
            filterModels(models, "glm-5.2").map { it.id },
        )
    }
}
