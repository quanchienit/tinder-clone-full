// src/config/socket.js
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import jwt from 'jsonwebtoken';
import redis from './redis.js';
import logger from '../shared/utils/logger.js';

class SocketManager {
  constructor() {
    this.io = null;
    this.users = new Map(); // userId -> Set of socket IDs
  }

  initialize(server) {
    try {
      // Create Socket.io server
      this.io = new Server(server, {
        cors: {
          origin: process.env.CLIENT_URL?.split(',') || ['http://localhost:19006'],
          credentials: true,
          methods: ['GET', 'POST'],
        },
        pingTimeout: 60000,
        pingInterval: 25000,
        transports: ['websocket', 'polling'],
        allowEIO3: true,
        maxHttpBufferSize: 1e6, // 1MB
      });

      // Use Redis adapter for scaling across multiple servers
      if (redis.isConnected) {
        const pubClient = redis.publisher;
        const subClient = redis.subscriber;
        this.io.adapter(createAdapter(pubClient, subClient));
        logger.info('✅ Socket.io Redis adapter configured');
      }

      // Authentication middleware
      this.io.use(async (socket, next) => {
        try {
          const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];
          
          if (!token) {
            return next(new Error('Authentication error: No token provided'));
          }

          const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
          
          // Attach user info to socket
          socket.userId = decoded.userId;
          socket.user = decoded;
          
          // Track user connection
          await this.handleUserConnection(socket.userId, socket.id);
          
          next();
        } catch (error) {
          logger.error('Socket authentication error:', error);
          next(new Error('Authentication error: Invalid token'));
        }
      });

      // Connection handler
      this.io.on('connection', (socket) => {
        logger.info(`User ${socket.userId} connected with socket ${socket.id}`);
        
        // Join user's personal room
        socket.join(`user:${socket.userId}`);
        
        // Emit connection success
        socket.emit('connected', {
          socketId: socket.id,
          userId: socket.userId,
        });

        // Handle disconnection
        socket.on('disconnect', async (reason) => {
          logger.info(`User ${socket.userId} disconnected: ${reason}`);
          await this.handleUserDisconnection(socket.userId, socket.id);
        });

        // Handle errors
        socket.on('error', (error) => {
          logger.error(`Socket error for user ${socket.userId}:`, error);
        });
      });

      logger.info('✅ Socket.io server initialized');
      return this.io;
    } catch (error) {
      logger.error('Failed to initialize Socket.io:', error);
      throw error;
    }
  }

  // User connection management
  async handleUserConnection(userId, socketId) {
    try {
      // Add socket to user's socket set
      if (!this.users.has(userId)) {
        this.users.set(userId, new Set());
      }
      this.users.get(userId).add(socketId);

      // Update online status in Redis
      await redis.sadd('users:online', userId);
      await redis.hset(`user:${userId}:sockets`, socketId, new Date().toISOString());
      
      // Set user as online with TTL (in case of unexpected disconnect)
      await redis.set(`presence:${userId}`, 'online', 300); // 5 minutes TTL

      // Publish user online event
      await redis.publish('user:status', {
        userId,
        status: 'online',
        timestamp: new Date().toISOString(),
      });

      // Notify friends that user is online
      this.notifyUserStatusChange(userId, 'online');
    } catch (error) {
      logger.error(`Error handling user connection for ${userId}:`, error);
    }
  }

  async handleUserDisconnection(userId, socketId) {
    try {
      // Remove socket from user's socket set
      const userSockets = this.users.get(userId);
      if (userSockets) {
        userSockets.delete(socketId);
        
        // If user has no more sockets, they're offline
        if (userSockets.size === 0) {
          this.users.delete(userId);
          
          // Update offline status in Redis
          await redis.srem('users:online', userId);
          await redis.del(`presence:${userId}`);
          
          // Publish user offline event
          await redis.publish('user:status', {
            userId,
            status: 'offline',
            timestamp: new Date().toISOString(),
          });

          // Notify friends that user is offline
          this.notifyUserStatusChange(userId, 'offline');
        }
      }

      // Remove specific socket from Redis
      await redis.hdel(`user:${userId}:sockets`, socketId);
    } catch (error) {
      logger.error(`Error handling user disconnection for ${userId}:`, error);
    }
  }

  // Emit to specific user (all their sockets)
  emitToUser(userId, event, data) {
    this.io.to(`user:${userId}`).emit(event, data);
  }

  // Emit to multiple users
  emitToUsers(userIds, event, data) {
    userIds.forEach(userId => {
      this.emitToUser(userId, event, data);
    });
  }

  // Emit to a room
  emitToRoom(room, event, data) {
    this.io.to(room).emit(event, data);
  }

  // Broadcast to all connected users except sender
  broadcast(socketId, event, data) {
    this.io.except(socketId).emit(event, data);
  }

  // Join a room
  joinRoom(socketId, room) {
    const socket = this.io.sockets.sockets.get(socketId);
    if (socket) {
      socket.join(room);
      logger.debug(`Socket ${socketId} joined room ${room}`);
    }
  }

  // Leave a room
  leaveRoom(socketId, room) {
    const socket = this.io.sockets.sockets.get(socketId);
    if (socket) {
      socket.leave(room);
      logger.debug(`Socket ${socketId} left room ${room}`);
    }
  }

  // Get all sockets for a user
  getUserSockets(userId) {
    return Array.from(this.users.get(userId) || []);
  }

  // Check if user is online
  isUserOnline(userId) {
    return this.users.has(userId) && this.users.get(userId).size > 0;
  }

  // Get online users count
  getOnlineUsersCount() {
    return this.users.size;
  }

  // Get all online user IDs
  getOnlineUserIds() {
    return Array.from(this.users.keys());
  }

  // Notify user status change to their matches
  async notifyUserStatusChange(userId, status) {
    try {
      // Get user's matches from database (this will be imported from match service)
      // For now, we'll just emit to a matches room
      this.io.to(`matches:${userId}`).emit('user:status:changed', {
        userId,
        status,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error(`Error notifying status change for ${userId}:`, error);
    }
  }

  // Room management for matches
  async joinMatchRoom(userId, matchId) {
    const sockets = this.getUserSockets(userId);
    sockets.forEach(socketId => {
      this.joinRoom(socketId, `match:${matchId}`);
    });
  }

  async leaveMatchRoom(userId, matchId) {
    const sockets = this.getUserSockets(userId);
    sockets.forEach(socketId => {
      this.leaveRoom(socketId, `match:${matchId}`);
    });
  }

  // Typing indicators
  async setTyping(matchId, userId, isTyping) {
    try {
      const key = `typing:${matchId}:${userId}`;
      
      if (isTyping) {
        // Set typing indicator with 3 second TTL
        await redis.set(key, '1', 3);
        
        // Emit to match room except sender
        const sockets = this.getUserSockets(userId);
        sockets.forEach(socketId => {
          const socket = this.io.sockets.sockets.get(socketId);
          if (socket) {
            socket.to(`match:${matchId}`).emit('typing:status', {
              userId,
              isTyping: true,
              matchId,
            });
          }
        });
      } else {
        // Remove typing indicator
        await redis.del(key);
        
        // Emit typing stopped
        this.io.to(`match:${matchId}`).emit('typing:status', {
          userId,
          isTyping: false,
          matchId,
        });
      }
    } catch (error) {
      logger.error(`Error setting typing status:`, error);
    }
  }

  // Get socket stats
  getStats() {
    return {
      connectedUsers: this.users.size,
      totalSockets: this.io.sockets.sockets.size,
      rooms: this.io.sockets.adapter.rooms.size,
    };
  }

  // Graceful shutdown
  async shutdown() {
    try {
      // Notify all clients
      this.io.emit('server:shutdown', {
        message: 'Server is shutting down',
        timestamp: new Date().toISOString(),
      });

      // Close all connections
      this.io.close();
      
      // Clear online users from Redis
      const onlineUsers = this.getOnlineUserIds();
      for (const userId of onlineUsers) {
        await redis.srem('users:online', userId);
        await redis.del(`presence:${userId}`);
        await redis.del(`user:${userId}:sockets`);
      }

      logger.info('Socket.io server shut down gracefully');
    } catch (error) {
      logger.error('Error shutting down Socket.io:', error);
    }
  }
}

export default new SocketManager();