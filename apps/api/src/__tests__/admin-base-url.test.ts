// Unit tests for the admin base URL reader + BKL-105 approval deep-link builder.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { adminBaseUrl, approvalDeepLink } from "../utils/admin-base-url.js";

describe("adminBaseUrl", () => {
  let originalUrl: string | undefined;
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalUrl = process.env.ADMIN_BASE_URL;
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (originalUrl !== undefined) process.env.ADMIN_BASE_URL = originalUrl;
    else delete process.env.ADMIN_BASE_URL;
    if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
    else delete process.env.NODE_ENV;
  });

  it("returns the configured URL (trimmed) when ADMIN_BASE_URL is set", () => {
    process.env.ADMIN_BASE_URL = "  https://admin.ibatexas.com.br  ";
    expect(adminBaseUrl()).toBe("https://admin.ibatexas.com.br");
  });

  it("dev-defaults to the admin app port (:3002) when unset outside production", () => {
    delete process.env.ADMIN_BASE_URL;
    process.env.NODE_ENV = "development";
    expect(adminBaseUrl()).toBe("http://localhost:3002");
  });

  it("returns undefined when unset in production (degrade, never a localhost link)", () => {
    delete process.env.ADMIN_BASE_URL;
    process.env.NODE_ENV = "production";
    expect(adminBaseUrl()).toBeUndefined();
  });

  it("still returns the configured URL in production when set", () => {
    process.env.ADMIN_BASE_URL = "https://admin.ibatexas.com.br";
    process.env.NODE_ENV = "production";
    expect(adminBaseUrl()).toBe("https://admin.ibatexas.com.br");
  });
});

describe("approvalDeepLink", () => {
  let originalUrl: string | undefined;
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalUrl = process.env.ADMIN_BASE_URL;
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (originalUrl !== undefined) process.env.ADMIN_BASE_URL = originalUrl;
    else delete process.env.ADMIN_BASE_URL;
    if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
    else delete process.env.NODE_ENV;
  });

  it("builds the BKL-105 route URL from ADMIN_BASE_URL", () => {
    process.env.ADMIN_BASE_URL = "https://admin.ibatexas.com.br";
    expect(approvalDeepLink("tok-abc123")).toBe(
      "https://admin.ibatexas.com.br/admin/aprovacoes/tok-abc123",
    );
  });

  it("normalizes a trailing slash on the base URL", () => {
    process.env.ADMIN_BASE_URL = "https://admin.ibatexas.com.br/";
    expect(approvalDeepLink("tok-abc123")).toBe(
      "https://admin.ibatexas.com.br/admin/aprovacoes/tok-abc123",
    );
  });

  it("URL-encodes the token", () => {
    process.env.ADMIN_BASE_URL = "https://admin.ibatexas.com.br";
    expect(approvalDeepLink("a b/c?d")).toBe(
      "https://admin.ibatexas.com.br/admin/aprovacoes/a%20b%2Fc%3Fd",
    );
  });

  it("returns undefined (omit the link) when unset in production", () => {
    delete process.env.ADMIN_BASE_URL;
    process.env.NODE_ENV = "production";
    expect(approvalDeepLink("tok-abc123")).toBeUndefined();
  });
});
