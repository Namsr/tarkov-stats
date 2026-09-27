import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    return nextResolve(specifier, context);
  },
});

const { GET } = await import("../app/api/security-txt/route.ts");

const DEFAULT_CONTACT = "Contact: mailto:namsrr@protonmail.com";

function setContact(value) {
  if (value === undefined) delete process.env.SECURITY_TXT_CONTACT;
  else process.env.SECURITY_TXT_CONTACT = value;
}

function restoreContact(t) {
  const previous = process.env.SECURITY_TXT_CONTACT;
  t.after(() => setContact(previous));
}

// RFC 9116 requires Contact in the first line, and it must parse as a mailto URI.
async function contactLine() {
  const response = await GET();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/plain/);
  const [line] = (await response.text()).split("\n");
  assert.match(line, /^Contact: /);
  const uri = new URL(line.slice("Contact: ".length));
  assert.equal(uri.protocol, "mailto:");
  assert.ok(uri.pathname.length > 0, "contact URI carries no address");
  return line;
}

test("security.txt falls back to the default contact when the env var is unset", async (t) => {
  restoreContact(t);
  setContact(undefined);
  assert.equal(await contactLine(), DEFAULT_CONTACT);
});

test("security.txt uses the configured contact", async (t) => {
  restoreContact(t);
  setContact("security@example.com");
  assert.equal(await contactLine(), "Contact: mailto:security@example.com");
});

test("security.txt falls back to the default contact for an empty value", async (t) => {
  restoreContact(t);
  setContact("");
  assert.equal(await contactLine(), DEFAULT_CONTACT);
});

test("security.txt falls back to the default contact for a whitespace value", async (t) => {
  restoreContact(t);
  setContact("   ");
  assert.equal(await contactLine(), DEFAULT_CONTACT);
});

test("security.txt does not repeat the mailto prefix", async (t) => {
  restoreContact(t);
  setContact("mailto:security@example.com");
  assert.equal(await contactLine(), "Contact: mailto:security@example.com");
  setContact("MAILTO:  security@example.com");
  assert.equal(await contactLine(), "Contact: mailto:security@example.com");
});
