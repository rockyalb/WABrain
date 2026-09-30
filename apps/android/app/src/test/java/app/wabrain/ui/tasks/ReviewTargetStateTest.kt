package app.wabrain.ui.tasks

import app.wabrain.data.api.ReviewDecisionResponse
import app.wabrain.data.api.ReviewItemDto
import app.wabrain.data.api.TaskDto
import org.junit.Assert.assertEquals
import org.junit.Test

class ReviewTargetStateTest {
    private fun review(state: String) = ReviewItemDto(
        id = "review-1",
        state = state,
        createdAt = "2026-09-30T08:00:00.000Z",
    )

    @Test
    fun pendingLookupTargetsTheProposal() {
        assertEquals(
            ReviewTargetState.Pending("review-1"),
            reviewTargetState("review-1", ReviewDecisionResponse(reviewItem = review("pending"))),
        )
    }

    @Test
    fun acceptedLookupCarriesTheResultingTaskLink() {
        val task = TaskDto(
            id = "task-1",
            title = "Send the contract",
            createdAt = "2026-09-30T08:01:00.000Z",
            updatedAt = "2026-09-30T08:01:00.000Z",
        )

        assertEquals(
            ReviewTargetState.Handled("review-1", "accepted", "task-1", "Send the contract"),
            reviewTargetState("review-1", ReviewDecisionResponse(review("accepted"), task)),
        )
    }

    @Test
    fun missingLookupProvidesAStaleNotificationFallback() {
        assertEquals(
            ReviewTargetState.Missing("review-1"),
            reviewTargetState("review-1", ReviewDecisionResponse()),
        )
    }
}
