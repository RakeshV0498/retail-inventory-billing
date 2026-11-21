import type { Db } from "@/db/client";

/** Anything that can run queries: the db itself or a transaction handle. */
export type Q = Pick<Db, "select" | "insert" | "update" | "delete">;

export class ServiceError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
