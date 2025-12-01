// api/detect.js - Main Detection Endpoint (Native Fetch - No Dependencies!)
// Images are NEVER stored - deleted immediately after processing
import formidable from 'formidable';
import fs from 'fs';
import { logDetection } from '../lib/database.js';

// Rate limiting (in-memory, resets on cold starts)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour
const MAX_REQUESTS = 5; // 5 requests per hour

// Allowed file settings
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

// Get client IP address
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || 
         req.headers['x-real-ip'] || 
         req.connection?.remoteAddress || 
         'unknown';
}

// Check rate limit
function checkRateLimit(ip) {
  const now = Date.now();
  const userRecord = rateLimitMap.get(ip);
  
  if (!userRecord) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return { allowed: true, remaining: MAX_REQUESTS - 1 };
  }
  
  if (now > userRecord.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return { allowed: true, remaining: MAX_REQUESTS - 1 };
  }
  
  if (userRecord.count >= MAX_REQUESTS) {
    return { allowed: false, remaining: 0, resetTime: userRecord.resetTime };
  }
  
  userRecord.count++;
  return { allowed: true, remaining: MAX_REQUESTS - userRecord.count };
}

// Parse uploaded file
function parseForm(req) {
  return new Promise((resolve, reject) => {
    const form = formidable({
      maxFileSize: MAX_FILE_SIZE,
      allowEmptyFiles: false,
      minFileSize: 1,
    });
    
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

// Convert image to base64
function imageToBase64(filePath) {
  const imageBuffer = fs.readFileSync(filePath);
  return imageBuffer.toString('base64');
}

// Delete image file immediately
function deleteImageFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log('✓ Image deleted:', filePath);
    }
  } catch (error) {
    console.error('Warning: Could not delete temp file:', error.message);
  }
}

// Call Roboflow API using NATIVE FETCH (no dependencies!)
async function callRoboflowAPI(base64Image, apiUrl, apiKey) {
  const response = await fetch(`${apiUrl}?api_key=${apiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: base64Image,
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Roboflow API error (${response.status}): ${errorText}`);
  }
  
  return response.json();
}

// Main handler
export default async function handler(req, res) {
  let uploadedFilePath = null; // Track file for cleanup
  
  try {
    // CORS headers
    const allowedOrigins = [
      process.env.ALLOWED_ORIGIN || 'http://localhost:3000',
      'https://*.vercel.app', // Allow all Vercel preview deployments
    ];
    
    const origin = req.headers.origin;
    if (origin && (allowedOrigins.includes(origin) || origin.includes('.vercel.app'))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // Handle preflight
    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }
    
    // Only accept POST
    if (req.method !== 'POST') {
      return res.status(405).json({ 
        error: 'Method not allowed',
        type: 'method_error' 
      });
    }
    
    // Check rate limit
    const clientIP = getClientIP(req);
    const RATE_LIMIT_PAUSED = process.env.RATE_LIMIT_PAUSED === "true";
    if (!RATE_LIMIT_PAUSED) {
        const rateLimit = checkRateLimit(clientIP);
    
    res.setHeader('X-RateLimit-Limit', MAX_REQUESTS);
    res.setHeader('X-RateLimit-Remaining', rateLimit.remaining);
    }
    if (!rateLimit.allowed) {
      const resetDate = new Date(rateLimit.resetTime);
      res.setHeader('X-RateLimit-Reset', resetDate.toISOString());
      
      return res.status(429).json({
        error: 'Too many requests. Please try again later.',
        type: 'rate_limit_error',
        resetTime: resetDate.toISOString()
      });
    }
    
    // Parse form data
    const { files } = await parseForm(req);
    
    // Validate image file
    const imageFile = files.image?.[0] || files.image;
    if (!imageFile) {
      return res.status(400).json({
        error: 'No image file provided',
        type: 'validation_error'
      });
    }
    
    // Track file path for cleanup
    uploadedFilePath = imageFile.filepath;
    
    // Validate file type
    if (!ALLOWED_TYPES.includes(imageFile.mimetype)) {
      deleteImageFile(uploadedFilePath);
      return res.status(400).json({
        error: 'Invalid file type. Only JPEG, PNG, and WebP are allowed.',
        type: 'validation_error'
      });
    }
    
    // Validate file size
    if (imageFile.size > MAX_FILE_SIZE) {
      deleteImageFile(uploadedFilePath);
      return res.status(400).json({
        error: 'File size exceeds 10MB limit',
        type: 'validation_error'
      });
    }
    
    // Convert to base64
    const base64Image = imageToBase64(uploadedFilePath);
    
    // Get API configuration
    const MODEL1_URL = process.env.ROBOFLOW_MODEL1_URL;
    const MODEL2_URL = process.env.ROBOFLOW_MODEL2_URL;
    const API_KEY = process.env.ROBOFLOW_API_KEY;
    
    if (!MODEL1_URL || !MODEL2_URL || !API_KEY) {
      console.error('Missing environment variables');
      deleteImageFile(uploadedFilePath);
      return res.status(500).json({
        error: 'Server configuration error',
        type: 'config_error'
      });
    }
    
    // Call Model 1 (Calamansi verification)
    console.log('Calling Model 1 (verification)...');
    const model1Response = await callRoboflowAPI(base64Image, MODEL1_URL, API_KEY);

// Debugging: log everything
console.log("Model 1 Raw Response:", JSON.stringify(model1Response, null, 2));

// Instead of just taking the first prediction blindly:
const predictions = model1Response.predictions || [];
const bestPrediction = predictions.sort((a, b) => b.confidence - a.confidence)[0];

if (!bestPrediction || bestPrediction.class.toLowerCase() !== "calamansi" || bestPrediction.confidence < 0.5) {
  deleteImageFile(uploadedFilePath);
  return res.status(400).json({
    error: "Image does not appear to be a calamansi plant.",
    type: "validation_error",
    detected: bestPrediction?.class,
    confidence: bestPrediction?.confidence
  });
}

const topPrediction = predictions[0];

console.log("Top Prediction:", topPrediction);

    
    const model1Prediction = model1Response.predictions?.[0] || model1Response.top;
    if (!model1Prediction) {
      deleteImageFile(uploadedFilePath);
      return res.status(500).json({
        error: 'Model 1 returned no predictions',
        type: 'model_error'
      });
    }
    
    const model1Class = model1Prediction.class || model1Prediction.className;
    const model1Confidence = Math.round((model1Prediction.confidence || 0) * 100);
    
    // Verify it's a calamansi
    const isCalamansi = model1Class?.toLowerCase().includes('calamansi');
    if (!isCalamansi || model1Confidence < 50) {
      deleteImageFile(uploadedFilePath);
      return res.status(400).json({
        error: 'Image does not appear to be a calamansi plant. Please upload a clear photo of a calamansi.',
        type: 'validation_error',
        detected: model1Class,
        confidence: model1Confidence
      });
    }
    
    // Call Model 2 (Disease detection)
    console.log('Calling Model 2 (disease detection)...');
    const model2Response = await callRoboflowAPI(base64Image, MODEL2_URL, API_KEY);
    
    const model2Prediction = model2Response.predictions?.[0];
    if (!model2Prediction) {
      deleteImageFile(uploadedFilePath);
      return res.status(500).json({
        error: 'Model 2 returned no predictions',
        type: 'model_error'
      });
    }
    
    const model2Class = model2Prediction.class;
    const model2Confidence = Math.round(model2Prediction.confidence * 100);
    const boundingBox = {
      x: model2Prediction.x,
      y: model2Prediction.y,
      width: model2Prediction.width,
      height: model2Prediction.height
    };
    
    const imageWidth = model2Response.image?.width || 640;
    const imageHeight = model2Response.image?.height || 640;
    
    const allPredictions = model2Response.predictions?.map(pred => ({
      class: pred.class,
      confidence: Math.round(pred.confidence * 100)
    })) || [];
    
    // Prepare response
    const timestamp = new Date().toISOString();
    const responseData = {
      model1: {
        class: model1Class,
        confidence: model1Confidence
      },
      model2: {
        class: model2Class,
        confidence: model2Confidence,
        boundingBox: boundingBox
      },
      imageData: `data:${imageFile.mimetype};base64,${base64Image}`,
      imageWidth: imageWidth,
      imageHeight: imageHeight,
      allPredictions: allPredictions,
      timestamp: timestamp
    };
    
    // Log to database (async, don't wait)
    logDetection({
      timestamp,
      ip: clientIP,
      model1Class,
      model1Confidence,
      model2Class,
      model2Confidence,
      imageMeta: {
        size: imageFile.size,
        type: imageFile.mimetype,
        width: imageWidth,
        height: imageHeight
      }
    }).catch(err => console.error('Logging error:', err));
    
    // DELETE IMAGE IMMEDIATELY (before sending response)
    deleteImageFile(uploadedFilePath);
    uploadedFilePath = null; // Mark as deleted
    
    // Return success
    return res.status(200).json(responseData);
    
  } catch (error) {
    console.error('Detection error:', error);
    
    // Clean up file on error
    if (uploadedFilePath) {
      deleteImageFile(uploadedFilePath);
    }
    
    // Handle specific errors
    if (error.message?.includes('maxFileSize')) {
      return res.status(400).json({
        error: 'File size exceeds maximum limit',
        type: 'validation_error'
      });
    }
    
    if (error.message?.includes('Roboflow')) {
      return res.status(502).json({
        error: 'AI model service is temporarily unavailable. Please try again.',
        type: 'service_error'
      });
    }
    
    return res.status(500).json({
      error: 'An unexpected error occurred during detection',
      type: 'server_error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

// Vercel config
export const config = {
  api: {
    bodyParser: false, // Required for formidable
  },
};