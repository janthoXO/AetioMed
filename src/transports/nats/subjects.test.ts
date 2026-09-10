import { describe, it, expect } from "vitest";
import { RetentionPolicy } from "@nats-io/jetstream";
import {
  subjectMatches,
  REQUEST_SUBJECT,
  resultSubject,
  progressSubject,
  cancelSubject,
  REQUESTS_STREAM,
  RESULTS_STREAM,
  RESULT_MAX_AGE_MS,
  CATALOG_DIAGNOSIS_SUBJECT,
  CATALOG_PROCEDURES_SUBJECT,
  META_FEATURES_SUBJECT,
  META_ALLOWED_LLMS_SUBJECT,
  META_GRAPH_SUBJECT,
} from "./subjects.js";

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
    catalogDiagnosis: CATALOG_DIAGNOSIS_SUBJECT,
    catalogProcedures: CATALOG_PROCEDURES_SUBJECT,
    metaFeatures: META_FEATURES_SUBJECT,
    metaAllowedLlms: META_ALLOWED_LLMS_SUBJECT,
    metaGraph: META_GRAPH_SUBJECT,
  };

  function matchingStreams(subject: string): string[] {
    return [REQUESTS_STREAM, RESULTS_STREAM]
      .filter((stream) =>
        stream.subjects.some((filter) => subjectMatches(filter, subject))
      )
      .map((stream) => stream.name);
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

  it("the two streams' filters don't overlap each other", () => {
    for (const subject of Object.values(sampleSubjects)) {
      expect(matchingStreams(subject).length).toBeLessThanOrEqual(1);
    }
    // And directly: neither stream's filter subjects match the other's.
    for (const filter of REQUESTS_STREAM.subjects) {
      for (const otherFilter of RESULTS_STREAM.subjects) {
        expect(subjectMatches(filter, otherFilter)).toBe(false);
        expect(subjectMatches(otherFilter, filter)).toBe(false);
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
});
