package app.wabrain.ui.people

import app.wabrain.data.api.MessageViewDto
import app.wabrain.data.db.ChatEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FactEvidenceTest {
    private fun chat(id: String, name: String?, jid: String = "$id@s.whatsapp.net", personId: String? = null, isGroup: Boolean = false) = ChatEntity(
        id = id,
        jid = jid,
        name = name,
        isGroup = isGroup,
        mode = "on",
        defaultContextId = null,
        contextConfirmed = true,
        autoCreate = true,
        minimumAutoConfidence = null,
        aliasesJson = "[]",
        personId = personId,
        lastMessageAt = null,
    )

    private fun message(id: String, chatId: String) = MessageViewDto(id = id, chatId = chatId, body = "body $id", at = "2026-09-01T09:00:00Z")

    // The person's own chat comes first in the list: the old code opened every source there.
    private val chats = listOf(
        chat("direct", "Arta", personId = "arta"),
        chat("group", "Office", jid = "1203@g.us", isGroup = true),
        chat("second", null, jid = "447690002222@s.whatsapp.net", personId = "arta"),
    )

    @Test
    fun everySourceKeepsTheFactOrderAndOpensInItsOwnChat() {
        val sources = factSources(
            sourceMessageIds = listOf("m-group", "m-direct", "m-second"),
            // The server returns messages oldest first, not in the fact's order.
            messages = listOf(message("m-direct", "direct"), message("m-second", "second"), message("m-group", "group")),
            chats = chats,
        )

        assertEquals(listOf("m-group", "m-direct", "m-second"), sources.map { it.messageId })
        assertEquals(listOf("group", "direct", "second"), sources.map { it.chatId })
        // A chat without a name falls back to its JID.
        assertEquals(listOf("Office", "Arta", "447690002222@s.whatsapp.net"), sources.map { it.chatName })
        assertTrue(sources.all { it.canOpen })
    }

    @Test
    fun aPurgedSourceIsListedButCannotBeOpened() {
        val sources = factSources(listOf("m-direct", "gone"), listOf(message("m-direct", "direct")), chats)

        assertEquals(2, sources.size)
        val missing = sources[1]
        assertEquals("gone", missing.messageId)
        assertNull(missing.message)
        assertNull(missing.chatId)
        assertFalse(missing.canOpen)
    }

    @Test
    fun aSourceInAChatNotYetSyncedStillOpensThereWithoutAName() {
        val sources = factSources(listOf("m-new"), listOf(message("m-new", "not-synced")), chats)

        assertEquals("not-synced", sources.single().chatId)
        assertNull(sources.single().chatName)
        assertTrue(sources.single().canOpen)
    }

    @Test
    fun duplicateSourceIdsAreShownOnce() {
        val sources = factSources(listOf("m-direct", "m-direct"), listOf(message("m-direct", "direct")), chats)

        assertEquals(listOf("m-direct"), sources.map { it.messageId })
    }
}
