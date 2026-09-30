import { describe, expect, it } from "vitest";
import { reviewTargetFromHash, reviewTargetHref } from "./review-target";

describe("review notification targets", () => {
  it("builds a canonical encoded Review route", () => {
    expect(reviewTargetHref("proposal/a b?")).toBe("#/tasks/review?item=proposal%2Fa%20b%3F");
  });

  it("reads the proposal from browser and service-worker forms of the route", () => {
    expect(reviewTargetFromHash("#/tasks/review?item=proposal%2Fa%20b%3F")).toBe("proposal/a b?");
    expect(reviewTargetFromHash("/#/tasks/review?item=r-2")).toBe("r-2");
  });

  it("does not turn a tab-only or unrelated route into an exact target", () => {
    expect(reviewTargetFromHash("#/tasks/review")).toBeNull();
    expect(reviewTargetFromHash("#/tasks/r-1?item=r-2")).toBeNull();
    expect(reviewTargetFromHash("#/tasks/review?item=%20%20")).toBeNull();
  });
});
