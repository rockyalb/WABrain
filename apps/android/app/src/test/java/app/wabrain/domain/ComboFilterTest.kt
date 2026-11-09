package app.wabrain.domain

import app.wabrain.data.db.ChatEntity
import app.wabrain.data.db.PersonEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ComboFilterTest {
    private val options = listOf(
        ComboOption("1", "Sam Carter", "+447911112233"),
        ComboOption("2", "Zoë Almirall", "+447822223344"),
        ComboOption("3", "Mira", null),
        ComboOption("4", "Family group", null),
    )

    private fun keys(query: String) = ComboFilter.filter(options, query).map { it.key }

    @Test
    fun blankQueryKeepsEveryOption() {
        assertEquals(listOf("1", "2", "3", "4"), keys("  "))
    }

    @Test
    fun accentsAndCaseAreIgnored() {
        assertEquals(listOf("2"), keys("zoe almirall"))
        assertEquals(listOf("2"), keys("ZOË"))
    }

    @Test
    fun everyWordMustMatch() {
        assertEquals(listOf("1"), keys("car sam"))
    }

    @Test
    fun namesStartingWithTheQueryComeFirst() {
        // "Mira" starts with "mira"; "Zoë Almirall" only contains it.
        assertEquals(listOf("3", "2"), keys("mira"))
    }

    @Test
    fun localNumbersFindTheirContact() {
        assertEquals(listOf("1"), keys("07911 112"))
        assertEquals(listOf("2"), keys("+44 78 222"))
        // Two digits are too few to search numbers by.
        assertEquals(emptyList<String>(), keys("06"))
    }

    @Test
    fun jidPhoneReadsDirectChatsOnly() {
        assertEquals("+447911112233", ComboFilter.jidPhone("447911112233@s.whatsapp.net"))
        assertEquals("+447911112233", ComboFilter.jidPhone("447911112233:12@c.us"))
        assertNull(ComboFilter.jidPhone("120363000000000000@g.us"))
        assertNull(ComboFilter.jidPhone("123456789012345@lid"))
    }

    @Test
    fun peopleAreSortedWithTheirDirectChatNumber() {
        val people = listOf(person("p1", "Nora"), person("p2", "Élodie"))
        val chats = listOf(
            chat("c1", "447911112233@s.whatsapp.net", personId = "p1"),
            chat("c2", "120363000000000000@g.us", personId = "p2", isGroup = true),
        )
        assertEquals(
            listOf(ComboOption("p2", "Élodie", null), ComboOption("p1", "Nora", "+447911112233")),
            ComboFilter.people(people, chats),
        )
    }

    private fun person(id: String, name: String) = PersonEntity(id = id, displayName = name, defaultContextId = null, updatedAt = 0, json = "{}")

    private fun chat(id: String, jid: String, personId: String?, isGroup: Boolean = false) = ChatEntity(
        id = id,
        jid = jid,
        name = null,
        isGroup = isGroup,
        mode = "on",
        defaultContextId = null,
        contextConfirmed = false,
        autoCreate = false,
        minimumAutoConfidence = null,
        aliasesJson = "[]",
        personId = personId,
        lastMessageAt = null,
    )
}
