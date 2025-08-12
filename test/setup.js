import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import redis from 'redis-mock';

let mongoServer;

export async function setupTestDB() {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  
  await mongoose.connect(mongoUri);
}

export async function teardownTestDB() {
  await mongoose.disconnect();
  await mongoServer.stop();
}

export function setupTestRedis() {
  return redis.createClient();
}
