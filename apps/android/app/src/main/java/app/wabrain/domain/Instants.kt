package app.wabrain.domain

import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** ISO-8601 helpers. The API always sends offsets ("Z" or "+02:00"). */
object Instants {
    fun parse(iso: String): Instant = OffsetDateTime.parse(iso).toInstant()

    fun parseMillis(iso: String): Long = parse(iso).toEpochMilli()

    fun format(millis: Long): String = DateTimeFormatter.ISO_INSTANT.format(Instant.ofEpochMilli(millis))

    fun zoneOrDefault(id: String?): ZoneId =
        runCatching { ZoneId.of(id ?: DEFAULT_ZONE) }.getOrElse { ZoneId.of(DEFAULT_ZONE) }

    /** Parses "HH:mm"; falls back to 17:00. */
    fun localTimeOrDefault(value: String?): LocalTime =
        runCatching { LocalTime.parse(value ?: "17:00") }.getOrElse { LocalTime.of(17, 0) }

    /** Date-only dues resolve to endOfWorkDay in the configured zone (same rule as the server). */
    fun endOfWorkDay(date: LocalDate, endOfWorkDay: LocalTime, zone: ZoneId): Instant =
        date.atTime(endOfWorkDay).atZone(zone).toInstant()

    const val DEFAULT_ZONE = "UTC"
}
