import { describe, it, expect } from "vitest";
import { RetentionPolicy } from "@nats-io/jetstream";
import {
  subjectMatches,
  REQUEST_SUBJECT,
  resultSubject,
  progressSubject,
  cancelSubject,
  reviewSubject,
  decisionSubject,
  reviewsStream,
  REQUESTS_STREAM,
  RESULTS_STREAM,
  RESULT_MAX_AGE_MS,
  CATALOG_DIAGNOSIS_SUBJECT,
  CATALOG_PROCEDURES_SUBJECT,
  META_FEATURES_SUBJECT,
  META_ALLOWED_LLMS_SUBJECT,
  META_GRAPH_SUBJECT,
} from "./subjects.js";

const REVIEWS_STREAM = reviewsStream(24 * 60 * 60 * 1000);

describe("subjectMatches", () => {
  it("matches a single-token wildcard (*)", () => {
    expect(subjectMatches("cases.result.*", "cases.result.job-1")).toBe(true);
    expect(subjectMatches("cases.result.*", "cases.result.job-1.extra")).toBe(
      false
    );
  });

  it("matches a trailing wildcard (>) over one or more tokens", () => {
    expect(subjectMatches("cases.>", "cases.request.generate")).toBe(true);
    expect(subjectMatches("cases.>", "cases.result.job-1")).toBe(true);
    expect(subjectMatches("cases.>", "cases")).toBe(false);
  });

  it("matches an exact subject", () => {
    expect(subjectMatches(REQUEST_SUBJECT, REQUEST_SUBJECT)).toBe(true);
    expect(subjectMatches(REQUEST_SUBJECT, "cases.request.other")).toBe(false);
  });

  it("does not match when lengths differ", () => {
    expect(subjectMatches("cases.request.*", "cases.request")).toBe(false);
    expect(
      subjectMatches("cases.request.*", "cases.request.generate.extra")
    ).toBe(false);
  });
});

describe("no stream captures another channel's subjects (#142)", () => {
  const sampleSubjects: Record<string, string> = {
    request: REQUEST_SUBJECT,
    result: resultSubject("j1"),
    progressLabel: progressSubject("j1", "label"),
    progressAccepted: progressSubject("j1", "accepted"),
    progressComplete: progressSubject("j1", "complete"),
    cancel: cancelSubject("j1"),
    review: reviewSubject("j1"),
    decision: decisionSubject("j1"),
    catalogDiagnosis: CATALOG_DIAGNOSIS_SUBJECT,
    catalogProcedures: CATALOG_PROCEDURES_SUBJECT,
    metaFeatures: META_FEATURES_SUBJECT,
    metaAllowedLlms: META_ALLOWED_LLMS_SUBJECT,
    metaGraph: META_GRAPH_SUBJECT,
  };

  const ALL_STREAMS = [REQUESTS_STREAM, RESULTS_STREAM, REVIEWS_STREAM];

  function matchingStreams(subject: string): string[] {
    return ALL_STREAMS.filter((stream) =>
      stream.subjects.some((filter) => subjectMatches(filter, subject))
    ).map((stream) => stream.name);
  }

  it("REQUESTS_STREAM matches only the request subject", () => {
    for (const [label, subject] of Object.entries(sampleSubjects)) {
      const matches = REQUESTS_STREAM.subjects.some((filter) =>
        subjectMatches(filter, subject)
      );
      expect([label, matches]).toEqual([label, label === "request"]);
    }
  });

  it("RESULTS_STREAM matches only the result subject", () => {
    for (const [label, subject] of Object.entries(sampleSubjects)) {
      const matches = RESULTS_STREAM.subjects.some((filter) =>
        subjectMatches(filter, subject)
      );
      expect([label, matches]).toEqual([label, label === "result"]);
    }
  });

  it("CASE_REVIEWS matches only the review subject (#159)", () => {
    for (const [label, subject] of Object.entries(sampleSubjects)) {
      const matches = REVIEWS_STREAM.subjects.some((filter) =>
        subjectMatches(filter, subject)
      );
      expect([label, matches]).toEqual([label, label === "review"]);
    }
  });

  it("cases.decision.<jobId> is captured by no stream at all (#159)", () => {
    expect(matchingStreams(decisionSubject("j1"))).toEqual([]);
  });

  it("no two streams' filters overlap each other", () => {
    for (const subject of Object.values(sampleSubjects)) {
      expect(matchingStreams(subject).length).toBeLessThanOrEqual(1);
    }
    // And directly: no stream's filter subjects match another's.
    for (const stream of ALL_STREAMS) {
      for (const other of ALL_STREAMS) {
        if (stream === other) continue;
        for (const filter of stream.subjects) {
          for (const otherFilter of other.subjects) {
            expect(subjectMatches(filter, otherFilter)).toBe(false);
          }
        }
      }
    }
  });
});

describe("stream retention configuration", () => {
  it("RESULTS_STREAM uses limits retention with a 1h max_age (in ns)", () => {
    expect(RESULTS_STREAM.retention).toBe(RetentionPolicy.Limits);
    expect(RESULT_MAX_AGE_MS).toBe(60 * 60 * 1000);
    expect(RESULTS_STREAM.max_age).toBe(RESULT_MAX_AGE_MS * 1_000_000);
  });

  it("REQUESTS_STREAM uses workqueue retention", () => {
    expect(REQUESTS_STREAM.retention).toBe(RetentionPolicy.Workqueue);
  });

  it("reviewsStream(reviewTtlMs) uses limits retention with max_age set from the given TTL (#159)", () => {
    expect(REVIEWS_STREAM.retention).toBe(RetentionPolicy.Limits);
    expect(REVIEWS_STREAM.subjects).toEqual(["cases.review.*"]);
    expect(reviewsStream(90_000).max_age).toBe(90_000 * 1_000_000);
  });
});
