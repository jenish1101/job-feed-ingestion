/** Opaque data encoded inside a pagination cursor token */
export interface CursorPayload {
  sourceId: string;
  externalJobId: string;
  status: string;
  filterSourceId: string | null;
}

/** Encodes a cursor payload to a URL-safe base64 string */
export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** Decodes a cursor string back to its payload, or returns null if invalid */
export function decodeCursor(value: string): CursorPayload | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.sourceId !== "string" ||
      typeof record.externalJobId !== "string"
    ) {
      return null;
    }
    if (typeof record.status !== "string") return null;
    if (
      record.filterSourceId !== null &&
      typeof record.filterSourceId !== "string"
    ) {
      return null;
    }
    return {
      sourceId: record.sourceId,
      externalJobId: record.externalJobId,
      status: record.status,
      filterSourceId: record.filterSourceId as string | null,
    };
  } catch {
    return null;
  }
}
