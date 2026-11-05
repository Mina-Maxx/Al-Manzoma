import mongoose from 'mongoose';
import { config } from '../config/index.js';

let isConnected = false;

export async function connectDatabase(uri?: string): Promise<typeof mongoose> {
  const mongoUri = uri || config.mongoUri;
  if (isConnected && mongoose.connection.readyState === 1) {
    return mongoose;
  }

  try {
    const conn = await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000,
      autoIndex: true,
    });
    isConnected = true;
    console.log(`[Database] MongoDB connected successfully to ${mongoUri.replace(/\/\/.*@/, '//***@')}`);
    return conn;
  } catch (error) {
    console.error('[Database] MongoDB connection failed:', error);
    throw error;
  }
}

export async function disconnectDatabase(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    isConnected = false;
    console.log('[Database] MongoDB disconnected');
  }
}
