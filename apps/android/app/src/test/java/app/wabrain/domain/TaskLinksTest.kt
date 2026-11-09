package app.wabrain.domain

import app.wabrain.data.api.LinkCandidateDto
import app.wabrain.data.api.TaskLinkDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TaskLinksTest {
    private val jordan = TaskLinkDto("Jordan", "c-jordan")
    private val robin = TaskLinkDto("Robin", null, listOf(LinkCandidateDto("c-robin-h", "Robin Hale"), LinkCandidateDto("c-robin-d", "Robin Diaz")))
    private val links = listOf(jordan, robin)
    private val names = mapOf("c-robin-h" to "Robin Hale", "c-taylor" to "Taylor")
    private fun apply(inputs: List<LinkInput>, own: String? = "c-casey") = TaskLinks.apply(links, inputs, own) { names[it] }

    @Test
    fun keepingTheListChangesNothing() {
        assertEquals(links, apply(TaskLinks.inputsOf(links)))
    }

    @Test
    fun pickingAChatConfirmsTheNameAsTheOwners() {
        val picked = apply(TaskLinks.pick(links, robin, "c-robin-h"))
        assertEquals(listOf(jordan, TaskLinkDto("Robin", "c-robin-h", source = "owner")), picked)
    }

    @Test
    fun removingDropsOnlyThatLink() {
        assertEquals(listOf(robin), apply(TaskLinks.remove(links, jordan)))
    }

    @Test
    fun addingLinksAChatByItsName() {
        val added = TaskLinks.add(links, "c-taylor")!!
        assertEquals(links + TaskLinkDto("Taylor", "c-taylor", source = "owner"), apply(added))
        assertNull(TaskLinks.add(links, "c-jordan"))
    }

    @Test
    fun neverLinksTheOwnChatOrTheSameChatTwice() {
        assertEquals(listOf(jordan), apply(listOf(LinkInput(null, "c-casey"), LinkInput("Jordan", "c-jordan"), LinkInput(null, "c-jordan"))))
    }

    @Test
    fun anUnconfirmedNameIsKeptButNeverInvented() {
        assertEquals(listOf(robin), apply(listOf(LinkInput("Robin", null), LinkInput("Taylor", null))))
    }

    @Test
    fun sendsTheListAsNamesAndChatIds() {
        assertEquals(
            """[{"name":"Jordan","chatId":"c-jordan"},{"name":"Robin","chatId":null},{"chatId":"c-taylor"}]""",
            TaskLinks.toJson(TaskLinks.add(links, "c-taylor")!!).toString(),
        )
    }
}
