// server.js
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import mongoose from 'mongoose';
import redis from './config/redis.js';
import { setupMiddleware } from './app.js';
// import { setupRoutes } from './routes.js';
import { setupSocketHandlers } from './modules/chat/chat.socket.js';
import { startBackgroundJobs } from './jobs/index.js';
import logger from './shared/utils/logger.js';

class TinderServer {
  constructor() {
    this.app = express();
    this.server = http.createServer(this.app);
    this.io = new Server(this.server, {
      cors: {
        origin: process.env.CLIENT_URL,
        credentials: true
      },
      adapter: createAdapter(redis.client)
    });
  }

  async initialize() {
    try {
      // Database connections
      await this.connectDatabases();
      
      // Setup middleware
      setupMiddleware(this.app);
      
      // Setup routes
      setupRoutes(this.app);
      
      // Setup WebSocket
      setupSocketHandlers(this.io);
      
      // Start background jobs
      startBackgroundJobs();
      
      // Error handling
      this.setupErrorHandling();
      
      // Start server
      const PORT = process.env.PORT || 3000;
      this.server.listen(PORT, () => {
        logger.info(`🚀 Server running on port ${PORT}`);
      });
      
    } catch (error) {
      logger.error('Failed to initialize server:', error);
      process.exit(1);
    }
  }

  async connectDatabases() {
    // MongoDB
    await mongoose.connect(process.env.MONGODB_URI, {
      maxPoolSize: 100,
      minPoolSize: 10
    });
    logger.info('✅ MongoDB connected');
    
    // Redis
    await redis.connect();
    logger.info('✅ Redis connected');
  }

  setupErrorHandling() {
    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({ error: 'Route not found' });
    });
    
    // Global error handler
    this.app.use((err, req, res, next) => {
      logger.error(err);
      res.status(err.statusCode || 500).json({
        error: err.message || 'Internal server error'
      });
    });
    
    // Graceful shutdown
    process.on('SIGTERM', this.gracefulShutdown.bind(this));
    process.on('SIGINT', this.gracefulShutdown.bind(this));
  }

  async gracefulShutdown() {
    logger.info('Starting graceful shutdown...');
    
    this.server.close(() => {
      logger.info('HTTP server closed');
    });
    
    await mongoose.connection.close();
    await redis.client.quit();
    
    process.exit(0);
  }
}

// Start server
const server = new TinderServer();
server.initialize();
