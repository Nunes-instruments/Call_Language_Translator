import type { Sql } from "postgres";
import type { DatabaseConnection } from "./managementStore.js";
/** Shares the existing Postgres.js pool; no second client or connection string. */
export function postgresConnection(sql: Sql): DatabaseConnection {
  const query = async <T = Record<string, unknown>>(text: string, parameters: unknown[] = []) => Array.from(await sql.unsafe(text, parameters as never[])) as T[];
  return { query, transaction: async <T>(operation: (db: DatabaseConnection) => Promise<T>): Promise<T> => {
    return await sql.begin(async tx => {
      const connection: DatabaseConnection = { query: async <R = Record<string, unknown>>(text: string, parameters: unknown[] = []) => Array.from(await tx.unsafe(text, parameters as never[])) as R[], transaction: operation => operation(connection) };
      return operation(connection);
    }) as T;
  } };
}
