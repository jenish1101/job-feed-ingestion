import type { JobPayload, ValidatedEvent } from "../types.js";

export type ValidationResult =
  { ok: true; event: ValidatedEvent } | { ok: false; errors: string[] };

const IDENTIFIERS = [
  "tenantId",
  "sourceId",
  "eventId",
  "externalJobId",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkIdentifier(
  body: Record<string, unknown>,
  field: string,
  errors: string[],
): string | null {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${field} must be a nonblank string`);
    return null;
  }
  if (value !== value.trim()) {
    errors.push(`${field} must not have surrounding whitespace`);
    return null;
  }
  return value;
}

function trimmedText(
  payload: Record<string, unknown>,
  field: string,
  errors: string[],
): string | null {
  const value = payload[field];
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${field} must be a nonblank string`);
    return null;
  }
  return value.trim();
}

function experience(
  payload: Record<string, unknown>,
  field: string,
  errors: string[],
): number | null {
  const value = payload[field];
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 50
  ) {
    errors.push(`${field} must be an integer from 0 to 50`);
    return null;
  }
  return value;
}

function normalizeSkills(value: unknown, errors: string[]): string[] | null {
  if (!Array.isArray(value)) {
    errors.push("skills must be an array of nonblank strings");
    return null;
  }
  const skills: string[] = [];
  const seen = new Set<string>();
  for (const skill of value) {
    if (typeof skill !== "string" || skill.trim() === "") {
      errors.push("skills must be an array of nonblank strings");
      return null;
    }
    const normalized = skill.trim().toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      skills.push(normalized);
    }
  }
  return skills;
}

function httpsUrl(value: unknown, errors: string[]): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push("applyUrl must be an https URL");
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      errors.push("applyUrl must be an https URL");
      return null;
    }
  } catch {
    errors.push("applyUrl must be an https URL");
    return null;
  }
  return value;
}

export function validateEvent(body: unknown): ValidationResult {
  if (!isRecord(body)) {
    return { ok: false, errors: ["request body must be a JSON object"] };
  }

  const errors: string[] = [];
  const identifiers: Partial<Record<(typeof IDENTIFIERS)[number], string>> = {};
  for (const field of IDENTIFIERS) {
    const value = checkIdentifier(body, field, errors);
    if (value !== null) identifiers[field] = value;
  }

  const version = body.version;
  const validVersion =
    typeof version === "number" &&
    Number.isSafeInteger(version) &&
    version >= 1;
  if (!validVersion) {
    errors.push("version must be a positive safe integer");
  }

  const operation = body.operation;
  if (operation !== "upsert" && operation !== "archive") {
    errors.push("operation must be upsert or archive");
  }

  let payload: JobPayload | undefined;
  if (operation === "archive") {
    if (Object.prototype.hasOwnProperty.call(body, "payload")) {
      errors.push("archive must omit payload");
    }
  } else if (operation === "upsert") {
    if (!isRecord(body.payload)) {
      errors.push("upsert requires a payload object");
    } else {
      const title = trimmedText(body.payload, "title", errors);
      const company = trimmedText(body.payload, "company", errors);
      const location = trimmedText(body.payload, "location", errors);
      const experienceMin = experience(body.payload, "experienceMin", errors);
      const experienceMax = experience(body.payload, "experienceMax", errors);
      if (
        experienceMin !== null &&
        experienceMax !== null &&
        experienceMin > experienceMax
      ) {
        errors.push("experienceMin must not be greater than experienceMax");
      }
      const applyUrl = httpsUrl(body.payload.applyUrl, errors);
      const skills = normalizeSkills(body.payload.skills, errors);
      if (
        title !== null &&
        company !== null &&
        location !== null &&
        experienceMin !== null &&
        experienceMax !== null &&
        applyUrl !== null &&
        skills !== null &&
        experienceMin <= experienceMax
      ) {
        payload = {
          title,
          company,
          location,
          experienceMin,
          experienceMax,
          applyUrl,
          skills,
        };
      }
    }
  }

  if (
    errors.length > 0 ||
    !validVersion ||
    (operation !== "upsert" && operation !== "archive")
  ) {
    return { ok: false, errors };
  }

  const tenantId = identifiers.tenantId;
  const sourceId = identifiers.sourceId;
  const eventId = identifiers.eventId;
  const externalJobId = identifiers.externalJobId;
  if (
    tenantId === undefined ||
    sourceId === undefined ||
    eventId === undefined ||
    externalJobId === undefined
  ) {
    return { ok: false, errors };
  }

  if (operation === "archive") {
    return {
      ok: true,
      event: {
        tenantId,
        sourceId,
        eventId,
        externalJobId,
        version,
        operation: "archive",
      },
    };
  }
  if (payload === undefined) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    event: {
      tenantId,
      sourceId,
      eventId,
      externalJobId,
      version,
      operation: "upsert",
      payload,
    },
  };
}
