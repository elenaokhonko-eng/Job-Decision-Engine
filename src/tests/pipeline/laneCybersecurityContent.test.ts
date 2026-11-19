import { describe, expect, it } from "vitest";
import { CYBERSECURITY_CONTENT_MIN_SIGNALS, hasCybersecurityFocus } from "../../pipeline/laneRouter.js";

// Synthetic texts only; no employer names.
const SECURITY_DUTIES = [
  "You will own threat detection and incident response for our SIEM.",
  "Triage vulnerabilities, run penetration testing and manage the attack surface.",
  "Harden endpoint security and enforce zero trust and identity and access management.",
].join(" ");

const ML_DUTIES = [
  "Train and evaluate machine learning models, build LLM and retrieval-augmented generation services,",
  "operate model serving and feature stores, and write PyTorch code.",
].join(" ");

describe("cybersecurity content rule", () => {
  it("excludes a role whose title says AI but whose duties are security work", () => {
    expect(hasCybersecurityFocus("Staff Software Engineer (AI Engineer)", SECURITY_DUTIES)).toBe(true);
  });

  it("excludes a plain security-function title without AI/ML words", () => {
    expect(hasCybersecurityFocus("Senior Security Engineer", "")).toBe(true);
    expect(hasCybersecurityFocus("Application Security Lead", "Own the roadmap.")).toBe(true);
  });

  it("keeps an ML role that only mentions security", () => {
    const scope = `${ML_DUTIES} You will also follow the vulnerability management policy and incident response runbook.`;
    expect(hasCybersecurityFocus("Machine Learning Engineer", scope)).toBe(false);
  });

  it("keeps a role when security phrases do not outnumber AI/ML phrases", () => {
    const lightSecurity = "Support threat detection, incident response, SIEM alerts and vulnerability triage.";
    expect(hasCybersecurityFocus("AI Engineer", `${lightSecurity} ${ML_DUTIES}`)).toBe(false);
  });

  it("needs the minimum number of distinct security phrases, and never invents a verdict from no text", () => {
    expect(CYBERSECURITY_CONTENT_MIN_SIGNALS).toBe(4);
    expect(hasCybersecurityFocus("AI Engineer", "Handle one vulnerability report and one malware ticket.")).toBe(false);
    expect(hasCybersecurityFocus("AI Engineer", "")).toBe(false);
  });

  it("does not match a title that merely contains the word secure or security in another sense", () => {
    expect(hasCybersecurityFocus("Software Engineer, Payments", "Build payment APIs.")).toBe(false);
  });
});
