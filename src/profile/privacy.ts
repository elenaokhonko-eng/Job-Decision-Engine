export interface ProfileFactModelSharingInput {
  readonly fact_type: unknown;
  readonly confidentiality: unknown;
}

export function isProfileFactModelShareable(fact: ProfileFactModelSharingInput): boolean {
  return fact.fact_type !== "CONTACT" &&
    (fact.confidentiality === "PUBLIC" || fact.confidentiality === "PRIVATE_REUSABLE");
}
