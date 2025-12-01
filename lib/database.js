// lib/database.js - Database helper for logging detections
// NO IMAGES STORED - only metadata logged
import pg from 'pg';
const { Pool } = pg;

let pool = null;

// Initialize database connection
function getPool() {
  if (!pool && process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      }
    });
  }
  return pool;
}

// Log detection attempt (NO IMAGE DATA - only metadata)
export async function logDetection(data) {
  const db = getPool();
  if (!db) {
    console.log('Database not configured, skipping log');
    return;
  }
  
  try {
    const query = `
      INSERT INTO detections (
        timestamp,
        ip_address,
        model1_class,
        model1_confidence,
        model2_class,
        model2_confidence,
        image_size,
        image_type,
        image_width,
        image_height,
        success
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id
    `;
    
    const values = [
      data.timestamp || new Date().toISOString(),
      data.ip || 'unknown',
      data.model1Class || null,
      data.model1Confidence || null,
      data.model2Class || null,
      data.model2Confidence || null,
      data.imageMeta?.size || null,
      data.imageMeta?.type || null,
      data.imageMeta?.width || null,
      data.imageMeta?.height || null,
      true
    ];
    
    const result = await db.query(query, values);
    console.log('✓ Detection logged to database (ID:', result.rows[0].id + ')');
    return result.rows[0].id;
  } catch (error) {
    console.error('Database logging error:', error.message);
    // Don't throw - logging failure shouldn't break detection
  }
}

// Get statistics (for your own monitoring)
export async function getStats(days = 7) {
  const db = getPool();
  if (!db) return null;
  
  try {
    const query = `
      SELECT 
        model2_class as disease,
        COUNT(*) as total_detections,
        AVG(model2_confidence) as avg_confidence
      FROM detections
      WHERE 
        success = TRUE 
        AND timestamp >= NOW() - INTERVAL '${days} days'
      GROUP BY model2_class
      ORDER BY total_detections DESC
    `;
    
    const result = await db.query(query);
    return result.rows;
  } catch (error) {
    console.error('Stats query error:', error);
    return null;
  }
}