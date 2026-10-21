import { beforeEach, describe, expect, test } from "vitest";

import {
  clearClaimLink,
  normalizeClaimCode,
  peekStashedClaimLink,
  readClaimLink,
} from "./claimLink";

function locationFor(pathname: string, search: string): Location {
  return { pathname, search } as Location;
}

beforeEach(() => {
  sessionStorage.clear();
});

describe("claim code normalization", () => {
  test("accepts what a person actually types", () => {
    expect(normalizeClaimCode("abcde12345")).toBe("ABCDE-12345");
    expect(normalizeClaimCode("  abcde-12345 ")).toBe("ABCDE-12345");
    expect(normalizeClaimCode("ABCDE 12345")).toBe("ABCDE-12345");
  });

  test("does not invent a separator for a partial code", () => {
    expect(normalizeClaimCode("abc")).toBe("ABC");
    expect(normalizeClaimCode("abcde")).toBe("ABCDE");
  });

  test("drops overflow rather than producing a code that cannot match", () => {
    expect(normalizeClaimCode("abcde12345extra")).toBe("ABCDE-12345");
  });
});

describe("reading a scanned claim link", () => {
  test("reads the device and code the QR carried", () => {
    const link = readClaimLink(locationFor("/claim", "?device=dev_42&code=ABCDE-12345"));
    expect(link).toEqual({ deviceId: "dev_42", code: "ABCDE-12345" });
  });

  test("normalizes a code that arrived unseparated", () => {
    const link = readClaimLink(locationFor("/claim", "?device=dev_42&code=abcde12345"));
    expect(link?.code).toBe("ABCDE-12345");
  });

  test("tolerates a trailing slash on the path", () => {
    expect(readClaimLink(locationFor("/claim/", "?device=dev_1&code=ABCDE12345"))).not.toBeNull();
  });

  test("ignores the query on any other route", () => {
    expect(readClaimLink(locationFor("/", "?device=dev_1&code=ABCDE12345"))).toBeNull();
  });

  test("requires both halves of the link", () => {
    expect(readClaimLink(locationFor("/claim", "?device=dev_1"))).toBeNull();
    expect(readClaimLink(locationFor("/claim", "?code=ABCDE12345"))).toBeNull();
  });

  // The whole point of the stash: an unauthenticated scan signs in first, and a redirect-based
  // Clerk flow rewrites the URL before the app reads it again.
  test("survives an auth round trip that discards the URL", () => {
    readClaimLink(locationFor("/claim", "?device=dev_42&code=ABCDE-12345"));
    const afterRedirect = readClaimLink(locationFor("/", ""));
    expect(afterRedirect).toEqual({ deviceId: "dev_42", code: "ABCDE-12345" });
  });

  test("a consumed link does not resurface on the next load", () => {
    readClaimLink(locationFor("/claim", "?device=dev_42&code=ABCDE-12345"));
    clearClaimLink();
    expect(peekStashedClaimLink()).toBeNull();
    expect(readClaimLink(locationFor("/", ""))).toBeNull();
  });

  test("a corrupt stash is ignored rather than thrown", () => {
    sessionStorage.setItem("nextCoderClaimLink", "{not json");
    expect(peekStashedClaimLink()).toBeNull();
    sessionStorage.setItem("nextCoderClaimLink", JSON.stringify({ deviceId: "dev_1" }));
    expect(peekStashedClaimLink()).toBeNull();
  });
});
