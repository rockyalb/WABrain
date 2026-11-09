package app.wabrain.domain

import app.wabrain.data.db.ChatEntity
import app.wabrain.data.db.PersonEntity
import java.text.Normalizer

/** One choice in a picker you can type into: [label] is matched by words, [detail] (a phone number) by digits. */
data class ComboOption<K>(val key: K, val label: String, val detail: String? = null)

/** The same matching as the web app's contact pickers, so a name or number finds the same people on both. */
object ComboFilter {
    private val marks = Regex("\\p{M}+")
    private val spaces = Regex("\\s+")
    private val phoneJid = Regex("^(\\d{6,15})(?::\\d+)?@(?:s\\.whatsapp\\.net|c\\.us)$")

    /** Lower case without accents, so "zoe" finds "Zoë" and "elodie" finds "Élodie". */
    fun fold(value: String): String = Normalizer.normalize(value, Normalizer.Form.NFD).replace(marks, "").lowercase()

    /** The phone number in a WhatsApp JID, e.g. "+447911123456"; null for groups and LIDs. */
    fun jidPhone(jid: String): String? = phoneJid.find(jid)?.let { "+${it.groupValues[1]}" }

    /**
     * Options whose label has every typed word, or whose number has the typed
     * digits. Names that start with the query come first; a blank query keeps them all.
     */
    fun <K> filter(options: List<ComboOption<K>>, query: String): List<ComboOption<K>> {
        val words = fold(query).split(spaces).filter { it.isNotEmpty() }
        if (words.isEmpty()) return options
        // Local numbers drop the leading 0 of the trunk prefix: "07911 123" finds +44 7911 123….
        val typed = query.filter(Char::isDigit)
        val digits = typed.trimStart('0')
        val first = words.first()
        val hits = options.filter { option ->
            val text = fold("${option.label} ${option.detail.orEmpty()}")
            words.all { text.contains(it) } ||
                (typed.length >= 3 && digits.isNotEmpty() && option.detail.orEmpty().filter(Char::isDigit).contains(digits))
        }
        fun rank(option: ComboOption<K>): Int {
            val label = fold(option.label)
            return when {
                label.startsWith(first) -> 0
                label.split(spaces).any { it.startsWith(first) } -> 1
                else -> 2
            }
        }
        // sortedBy is stable, so equal ranks keep their order.
        return hits.sortedBy(::rank)
    }

    /** People by name, each with the number of their direct chat. */
    fun people(people: List<PersonEntity>, chats: List<ChatEntity>): List<ComboOption<String>> {
        val phones = chats.filter { !it.isGroup && it.personId != null }
            .mapNotNull { chat -> jidPhone(chat.jid)?.let { chat.personId!! to it } }
            .toMap()
        return people.sortedBy { fold(it.displayName) }.map { ComboOption(it.id, it.displayName, phones[it.id]) }
    }
}
