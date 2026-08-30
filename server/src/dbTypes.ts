import type { Pool, PoolClient } from 'pg';

// A pool works for standalone reads; a checked-out client is used inside a transaction.
// Both expose the same .query() surface used throughout this codebase.
export type Queryable = Pool | PoolClient;
