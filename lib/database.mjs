import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Configure .env and run npm run db:migrate.');

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_SIZE || 10),
  ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false },
});

export async function asUser(userId, callback) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.current_user_id', $1, true)", [userId]);
    const result = await callback(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally { client.release(); }
}
