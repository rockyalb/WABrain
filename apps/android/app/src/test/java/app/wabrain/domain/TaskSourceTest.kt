package app.wabrain.domain

import app.wabrain.data.db.ChatEntity
import app.wabrain.data.db.PersonEntity
import app.wabrain.data.api.TaskLinkDto
import app.wabrain.data.db.TaskEntity
import app.wabrain.data.db.encodeLinks
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TaskSourceTest {
    private fun task(chatId: String? = null, personId: String? = null, links: List<TaskLinkDto> = emptyList()) = TaskEntity(
        id = "t",
        kind = "todo",
        status = "open",
        title = "t",
        description = "",
        dueAt = null,
        dueHasTime = false,
        contextId = null,
        chatId = chatId,
        personId = personId,
        origin = "ai",
        language = null,
        confidence = null,
        evidenceMessageIds = "[]",
        createdAt = 0,
        updatedAt = 0,
        closedAt = null,
        linksJson = encodeLinks(links),
    )

    private fun chat(id: String, name: String?, isGroup: Boolean, personId: String? = null) = ChatEntity(
        id = id,
        jid = if (isGroup) "120363041234567890@g.us" else "447691234567@s.whatsapp.net",
        name = name,
        isGroup = isGroup,
        mode = "on",
        defaultContextId = null,
        contextConfirmed = true,
        autoCreate = false,
        minimumAutoConfidence = null,
        aliasesJson = "[]",
        personId = personId,
        lastMessageAt = null,
    )

    private fun person(id: String, name: String) = PersonEntity(id = id, displayName = name, defaultContextId = null, updatedAt = 0, json = "{}")

    private val chats = listOf(
        chat("family", "Family", isGroup = true),
        chat("sam-dm", "Sam", isGroup = false, personId = "sam"),
        chat("unnamed-group", null, isGroup = true),
    ).associateBy { it.id }
    private val people = listOf(person("mira", "Mira"), person("sam", "Sam Carter")).associateBy { it.id }

    @Test
    fun groupTaskShowsTheGroupAndThePerson() {
        assertEquals("Family · Mira", TaskSource.of(task("family", "mira"), chats, people)?.label)
    }

    @Test
    fun groupTaskWithoutAPersonShowsTheGroup() {
        assertEquals("Family", TaskSource.of(task("family"), chats, people)?.label)
    }

    @Test
    fun directChatShowsTheContactFromTheChatWhenTheTaskHasNoPerson() {
        assertEquals("Sam Carter", TaskSource.of(task("sam-dm"), chats, people)?.label)
    }

    @Test
    fun unnamedGroupFallsBackToItsId() {
        assertEquals("120363041234567890", TaskSource.of(task("unnamed-group"), chats, people)?.label)
    }

    @Test
    fun personWithoutAChatShowsThePerson() {
        assertEquals("Mira", TaskSource.of(task(personId = "mira"), chats, people)?.label)
    }

    @Test
    fun manualTaskHasNoSource() {
        assertNull(TaskSource.of(task(), chats, people))
    }

    @Test
    fun linkedChatsFollowTheSourceByTheirContactName() {
        val links = listOf(TaskLinkDto("Sam", "sam-dm"), TaskLinkDto("Robin", null), TaskLinkDto("the family group", "family"))
        val source = TaskSource.of(task("family", "mira", links), chats, people)!!
        assertEquals("Family · Mira", source.label)
        assertEquals("→ Sam Carter, Family, Robin?", source.linkLabel)
    }

    @Test
    fun aManualTaskWithALinkShowsOnlyTheLink() {
        val source = TaskSource.of(task(links = listOf(TaskLinkDto("Jordan", "gone"))), chats, people)!!
        assertNull(source.groupName ?: source.personName)
        assertEquals("→ Jordan", source.linkLabel)
    }

    @Test
    fun noLinksNoLinkLabel() {
        assertNull(TaskSource.of(task("family"), chats, people)?.linkLabel)
    }
}
