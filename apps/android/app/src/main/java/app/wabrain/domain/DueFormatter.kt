package app.wabrain.domain

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.temporal.ChronoUnit
import java.util.Locale

/** Localized words the formatter needs; resolved from string resources in the app. */
data class DueWords(
    val today: String,
    val tomorrow: String,
    val yesterday: String,
)

/**
 * Formats due dates in the server-configured timezone (not the phone's), so a
 * task "due 17:00 Europe/Rome" reads the same wherever the phone is.
 */
class DueFormatter(
    private val zone: ZoneId,
    private val locale: Locale,
    private val words: DueWords,
) {
    private val time = DateTimeFormatter.ofPattern("HH:mm", locale)
    private val weekday = DateTimeFormatter.ofPattern("EEE d MMM", locale)
    private val fullDate = DateTimeFormatter.ofPattern("d MMM yyyy", locale)
    private val dateTime = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT).withLocale(locale)

    /**
     * "Today 14:30", "Tomorrow", "Fri 2 Oct 09:00", "3 Jan 2027".
     * A date-only due ([hasTime] false) omits the time, since it is only the
     * end-of-work-day placeholder.
     */
    fun formatDue(dueAtMillis: Long, hasTime: Boolean, now: Instant): String {
        val due = Instant.ofEpochMilli(dueAtMillis).atZone(zone)
        val today = now.atZone(zone).toLocalDate()
        val date = due.toLocalDate()
        val days = ChronoUnit.DAYS.between(today, date)
        val datePart = when {
            days == 0L -> words.today
            days == 1L -> words.tomorrow
            days == -1L -> words.yesterday
            date.year == today.year -> weekday.format(due)
            else -> fullDate.format(due)
        }
        return if (hasTime) "$datePart ${time.format(due)}" else datePart
    }

    /** Timestamp such as a message time or an event time. */
    fun formatInstant(millis: Long): String = dateTime.format(Instant.ofEpochMilli(millis).atZone(zone))

    fun formatInstant(iso: String): String = runCatching { formatInstant(Instants.parseMillis(iso)) }.getOrDefault(iso)
}
