import { z } from "zod";

export const ContactFactKeySchema = z.enum([
  "contact_name",
  "contact_full_name",
  "contact_location",
  "contact_email",
  "contact_phone",
  "contact_linkedin",
  "contact_work_authorisation",
]);

export const ContactFactKindSchema = z.enum([
  "name",
  "location",
  "email",
  "phone",
  "linkedin",
  "work_authorisation",
]);

export const ContactFactValueSchema = z.object({
  kind: ContactFactKindSchema,
  value: z.string().trim().min(1),
}).strict();

export const CONTACT_FACT_DEFINITIONS = {
  contact_name: { field: "full_name", kind: "name" },
  contact_full_name: { field: "full_name", kind: "name" },
  contact_location: { field: "location", kind: "location" },
  contact_email: { field: "email", kind: "email" },
  contact_phone: { field: "phone", kind: "phone" },
  contact_linkedin: { field: "linkedin", kind: "linkedin" },
  contact_work_authorisation: { field: "work_authorisation", kind: "work_authorisation" },
} as const;

export type ContactFactKey = z.infer<typeof ContactFactKeySchema>;

export function getContactFactDefinition(factKey: string) {
  const parsed = ContactFactKeySchema.safeParse(factKey);
  return parsed.success ? CONTACT_FACT_DEFINITIONS[parsed.data] : undefined;
}

export const ContactFactRevisionSchema = z.object({
  fact_type: z.literal("CONTACT"),
  fact_key: ContactFactKeySchema,
  structured_value: ContactFactValueSchema,
  verification_status: z.enum(["VERIFIED", "SELF_ATTESTED"]),
  confidentiality: z.literal("PRIVATE_INTERNAL"),
}).superRefine((fact, context) => {
  const definition = CONTACT_FACT_DEFINITIONS[fact.fact_key];
  if (fact.structured_value.kind !== definition.kind) {
    context.addIssue({
      code: "custom",
      path: ["structured_value", "kind"],
      message: `Contact fact ${fact.fact_key} requires kind ${definition.kind}.`,
    });
  }
});
