// src/config/database.js
import mongoose from 'mongoose';
import logger from '../shared/utils/logger.js';

class Database {
  constructor() {
    this.connection = null;
  }

  async connect() {
    try {
      const options = {
        maxPoolSize: parseInt(process.env.DB_POOL_SIZE) || 100,
        minPoolSize: parseInt(process.env.DB_MIN_POOL_SIZE) || 10,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
        family: 4, // Use IPv4
        authSource: 'admin',
      };

      // Set mongoose options
      mongoose.set('strictQuery', false);
      
      // Enable debug in development
      if (process.env.NODE_ENV === 'development') {
        mongoose.set('debug', true);
      }

      // Event listeners
      mongoose.connection.on('connecting', () => {
        logger.info('Connecting to MongoDB...');
      });

      mongoose.connection.on('connected', () => {
        logger.info('✅ MongoDB connected successfully');
      });

      mongoose.connection.on('error', (err) => {
        logger.error('MongoDB connection error:', err);
      });

      mongoose.connection.on('disconnected', () => {
        logger.warn('MongoDB disconnected');
      });

      mongoose.connection.on('reconnected', () => {
        logger.info('MongoDB reconnected');
      });

      // Connect to MongoDB
      this.connection = await mongoose.connect(
        process.env.MONGODB_URI || 'mongodb://localhost:27017/tinder',
        options
      );

      // Handle process termination
      process.on('SIGINT', this.gracefulShutdown.bind(this));
      process.on('SIGTERM', this.gracefulShutdown.bind(this));

      return this.connection;
    } catch (error) {
      logger.error('Failed to connect to MongoDB:', error);
      // Retry connection after 5 seconds
      setTimeout(() => this.connect(), 5000);
      throw error;
    }
  }

  async gracefulShutdown() {
    try {
      await mongoose.connection.close();
      logger.info('MongoDB connection closed through app termination');
      process.exit(0);
    } catch (error) {
      logger.error('Error during MongoDB shutdown:', error);
      process.exit(1);
    }
  }

  async disconnect() {
    try {
      await mongoose.connection.close();
      logger.info('MongoDB disconnected successfully');
    } catch (error) {
      logger.error('Error disconnecting from MongoDB:', error);
      throw error;
    }
  }

  // Health check
  isConnected() {
    return mongoose.connection.readyState === 1;
  }

  // Get connection stats
  getStats() {
    const { readyState, host, port, name } = mongoose.connection;
    const states = {
      0: 'disconnected',
      1: 'connected',
      2: 'connecting',
      3: 'disconnecting',
    };

    return {
      status: states[readyState],
      host,
      port,
      database: name,
      readyState,
    };
  }

  // Create indexes
  async createIndexes() {
    try {
      logger.info('Creating database indexes...');
      
      // Import models to ensure indexes are created
      const models = [
        '../modules/user/user.model.js',
        '../modules/match/match.model.js',
        '../modules/match/swipe.model.js',
        '../modules/chat/message.model.js',
        '../modules/notification/notification.model.js'
      ];

      for (const modelPath of models) {
        try {
          await import(modelPath);
        } catch (error) {
          logger.warn(`Could not import model ${modelPath}:`, error.message);
        }
      }

      // Ensure all indexes are created
      await Promise.all(
        mongoose.modelNames().map(modelName =>
          mongoose.model(modelName).createIndexes()
        )
      );

      logger.info('✅ Database indexes created successfully');
    } catch (error) {
      logger.error('Error creating indexes:', error);
      throw error;
    }
  }
}

export default new Database();