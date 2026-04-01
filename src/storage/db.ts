/**
 * Database connection and query utilities for OpenMemory.
 * 
 * All queries go through here. AGE graph queries need special handling
 * because they use Cypher syntax wrapped in ag_catalog functions.
 * 
 * Production (Fly.io): AGE extension not available — only standard SQL works.
 * Local dev: Full AGE + pgvector support.
 */

import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const isProduction = !!process.env.BRAIN_API_KEY;

// Connection pool — shared across the app
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5433'),
  database: process.env.DB_NAME || 'open_memory',
  user: process.env.DB_USER || 'open_memory',
  password: process.env.DB_PASSWORD || 'open_memory_dev',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

/**
 * Execute a SQL query with parameters.
 * In local dev, loads AGE extension on each query.
 * In production, skips AGE (not available on managed Postgres).
 */
export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  const client = await pool.connect();
  try {
    if (!isProduction) {
      try {
        await client.query("LOAD 'age'");
        await client.query("SET search_path = ag_catalog, public");
      } catch {
        // AGE not available — continue without graph support
      }
    }
    const result = await client.query<T>(text, params);
    const duration = Date.now() - start;
  
    // Log slow queries (>100ms)
    if (duration > 100) {
      console.warn(`[SLOW QUERY] ${duration}ms: ${text.substring(0, 80)}...`);
    }
    
    return result;
  } finally {
    client.release();
  }
}

/**
 * Execute an AGE Cypher query on the memory_graph.
 * Only works in local dev with AGE extension loaded.
 */
export async function cypher<T = any>(
  cypherQuery: string,
  returnColumns: string = 'result agtype'
): Promise<T[]> {
  if (isProduction) {
    throw new Error('Cypher queries not available in production (AGE extension not installed)');
  }
  const client = await pool.connect();
  try {
    await client.query("LOAD 'age'");
    await client.query("SET search_path = ag_catalog, public");
    const sql = `SELECT * FROM cypher('memory_graph', $cypher$${cypherQuery}$cypher$) AS (${returnColumns})`;
    const result = await client.query(sql);
    return result.rows as T[];
  } finally {
    client.release();
  }
}

/**
 * Execute multiple queries in a transaction.
 */
export async function transaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Health check — verify DB connection and AGE extension.
 */
export async function healthCheck(): Promise<{
  connected: boolean;
  age_loaded: boolean;
  graph_exists: boolean;
  tables: string[];
  identity_count: number;
}> {
  try {
    // Basic connectivity
    await pool.query('SELECT 1');
    
    if (isProduction) {
      // Minimal health check for production (no AGE)
      return {
        connected: true,
        age_loaded: false,
        graph_exists: false,
        tables: [],
        identity_count: 0,
      };
    }

    // AGE loaded?
    const ageCheck = await pool.query(
      "SELECT extname FROM pg_extension WHERE extname = 'age'"
    );
    
    // Graph exists?
    const graphCheck = await pool.query(
      "SELECT graphid FROM ag_graph WHERE name = 'memory_graph'"
    );
    
    // Tables?
    const tables = await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'ag_catalog' AND tablename NOT LIKE 'ag_%' ORDER BY tablename"
    );
    
    // Identity seeded?
    const identity = await pool.query('SELECT COUNT(*) as count FROM identity');
    
    return {
      connected: true,
      age_loaded: ageCheck.rows.length > 0,
      graph_exists: graphCheck.rows.length > 0,
      tables: tables.rows.map((r: any) => r.tablename),
      identity_count: parseInt(identity.rows[0].count),
    };
  } catch (err) {
    return {
      connected: false,
      age_loaded: false,
      graph_exists: false,
      tables: [],
      identity_count: 0,
    };
  }
}

/**
 * Graceful shutdown.
 */
export async function shutdown(): Promise<void> {
  await pool.end();
}

export default pool;
