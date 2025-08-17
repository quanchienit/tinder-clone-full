// src/shared/services/email.service.js
import nodemailer from 'nodemailer';
import sgMail from '@sendgrid/mail';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import redis from '../../config/redis.js';
import logger from '../utils/logger.js';
import CacheService from './cache.service.js';
import MetricsService from './metrics.service.js';
import QueueService from './queue.service.js';
import AppError from '../errors/AppError.js';
import { 
  NOTIFICATION_TYPES, 
  ERROR_CODES,
  HTTP_STATUS,
  EMAIL_TEMPLATES 
} from '../../config/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class EmailService {
  constructor() {
    this.transporter = null;
    this.provider = null; // 'smtp' or 'sendgrid'
    this.initialized = false;
    this.templates = new Map();
    this.defaultConfig = {
      from: process.env.FROM_EMAIL || 'noreply@tinderclone.com',
      fromName: process.env.FROM_NAME || 'Tinder Clone',
      replyTo: process.env.REPLY_TO_EMAIL,
      unsubscribeUrl: process.env.UNSUBSCRIBE_URL,
      baseUrl: process.env.FRONTEND_URL || 'https://app.tinderclone.com',
      logoUrl: process.env.LOGO_URL || 'https://app.tinderclone.com/logo.png',
    };
  }

  /**
   * Initialize email service
   */
  async initialize() {
    try {
      // Initialize SendGrid if API key is provided
      if (process.env.SENDGRID_API_KEY) {
        sgMail.setApiKey(process.env.SENDGRID_API_KEY);
        this.transporter = sgMail;
        this.provider = 'sendgrid';
        
        // Verify SendGrid configuration
        await this.verifySendGridConfig();
        logger.info('✅ SendGrid configured for email service');

      } else if (process.env.SMTP_HOST) {
        // Initialize SMTP transporter
        this.transporter = nodemailer.createTransporter({
          host: process.env.SMTP_HOST,
          port: parseInt(process.env.SMTP_PORT) || 587,
          secure: process.env.SMTP_SECURE === 'true',
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASSWORD,
          },
          pool: true,
          maxConnections: 5,
          maxMessages: 100,
          rateDelta: 1000,
          rateLimit: 5,
        });

        this.provider = 'smtp';

        // Verify SMTP configuration
        await this.transporter.verify();
        logger.info('✅ SMTP configured for email service');

      } else {
        logger.warn('Email configuration not found. Email service disabled.');
        return;
      }

      // Load email templates
      await this.loadEmailTemplates();

      // Register queue handler
      QueueService.registerHandler('emails', this.processEmailJob.bind(this));

      this.initialized = true;
      logger.info('✅ Email service initialized');

    } catch (error) {
      logger.error('Failed to initialize email service:', error);
      throw error;
    }
  }

  /**
   * Send email
   * @param {Object} emailData - Email data
   * @param {Object} options - Additional options
   */
  async sendEmail(emailData, options = {}) {
    try {
      if (!this.initialized) {
        throw new AppError('Email service not initialized', HTTP_STATUS.SERVICE_UNAVAILABLE, ERROR_CODES.SERVICE_UNAVAILABLE);
      }

      const startTime = Date.now();
      const { to, subject, template, templateData = {}, priority = 'normal' } = emailData;

      // Validate email address
      if (!this.isValidEmail(to)) {
        throw new AppError('Invalid email address', HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR);
      }

      // Check if user has unsubscribed
      const isUnsubscribed = await this.checkUnsubscribed(to);
      if (isUnsubscribed) {
        logger.info(`Email not sent to ${to} - user has unsubscribed`);
        return { success: false, reason: 'unsubscribed' };
      }

      // Prepare email content
      const emailContent = await this.prepareEmailContent(template, templateData, options);

      // Merge with email data
      const finalEmailData = {
        to,
        subject,
        from: `${this.defaultConfig.fromName} <${this.defaultConfig.from}>`,
        replyTo: this.defaultConfig.replyTo,
        ...emailContent,
        ...options.overrides,
      };

      // Add tracking parameters
      if (options.trackClicks !== false) {
        finalEmailData.html = this.addTrackingToHtml(finalEmailData.html, to, template);
      }

      // Send email based on provider
      let result;
      if (this.provider === 'sendgrid') {
        result = await this.sendViaSendGrid(finalEmailData, options);
      } else {
        result = await this.sendViaSMTP(finalEmailData, options);
      }

      // Track metrics
      const processingTime = Date.now() - startTime;
      await this.trackEmailMetrics(to, template, true, processingTime);

      logger.info(`Email sent successfully to ${to} using template ${template}`);

      return {
        success: true,
        messageId: result.messageId,
        processingTime,
        provider: this.provider,
      };

    } catch (error) {
      logger.error(`Error sending email to ${emailData.to}:`, error);
      
      // Track failed metrics
      await this.trackEmailMetrics(emailData.to, emailData.template, false, 0, error.message);
      
      throw error;
    }
  }

  /**
   * Send bulk emails
   * @param {Array} emails - Array of email data objects
   * @param {Object} options - Bulk options
   */
  async sendBulkEmails(emails, options = {}) {
    try {
      const { batchSize = 50, maxConcurrency = 3, delayBetweenBatches = 1000 } = options;
      const results = {
        success: [],
        failed: [],
        totalSent: 0,
        totalFailed: 0,
      };

      logger.info(`Starting bulk email send for ${emails.length} emails`);

      // Process in batches
      for (let i = 0; i < emails.length; i += batchSize) {
        const batch = emails.slice(i, i + batchSize);
        
        // Process batch with concurrency limit
        const batchPromises = batch.map(async (emailData) => {
          try {
            const result = await this.sendEmail(emailData, options);
            if (result.success) {
              results.success.push({ email: emailData.to, messageId: result.messageId });
              results.totalSent += 1;
            } else {
              results.failed.push({ email: emailData.to, reason: result.reason });
              results.totalFailed += 1;
            }
          } catch (error) {
            results.failed.push({ email: emailData.to, error: error.message });
            results.totalFailed += 1;
          }
        });

        // Limit concurrency
        const chunks = [];
        for (let j = 0; j < batchPromises.length; j += maxConcurrency) {
          chunks.push(batchPromises.slice(j, j + maxConcurrency));
        }

        for (const chunk of chunks) {
          await Promise.all(chunk);
        }

        // Delay between batches to avoid rate limiting
        if (i + batchSize < emails.length && delayBetweenBatches > 0) {
          await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
        }

        logger.debug(`Processed batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(emails.length / batchSize)}`);
      }

      logger.info(`Bulk email send completed: ${results.totalSent} sent, ${results.totalFailed} failed`);
      
      // Track bulk metrics
      await MetricsService.incrementCounter('emails.bulk.sent', results.totalSent);
      await MetricsService.incrementCounter('emails.bulk.failed', results.totalFailed);

      return results;

    } catch (error) {
      logger.error('Error sending bulk emails:', error);
      throw error;
    }
  }

  /**
   * Send via SendGrid
   * @private
   */
  async sendViaSendGrid(emailData, options = {}) {
    try {
      const msg = {
        to: emailData.to,
        from: emailData.from,
        subject: emailData.subject,
        text: emailData.text,
        html: emailData.html,
        replyTo: emailData.replyTo,
        categories: [emailData.template || 'general'],
        customArgs: {
          template: emailData.template,
          timestamp: new Date().toISOString(),
          ...(options.customArgs || {}),
        },
      };

      // Add attachments if any
      if (emailData.attachments) {
        msg.attachments = emailData.attachments.map(att => ({
          content: att.content,
          filename: att.filename,
          type: att.type,
          disposition: att.disposition || 'attachment',
        }));
      }

      // Add unsubscribe link
      if (this.defaultConfig.unsubscribeUrl) {
        msg.asm = {
          groupId: parseInt(process.env.SENDGRID_UNSUBSCRIBE_GROUP_ID) || 1,
          groupsToDisplay: [parseInt(process.env.SENDGRID_UNSUBSCRIBE_GROUP_ID) || 1],
        };
      }

      const response = await this.transporter.send(msg);
      
      return {
        messageId: response[0].headers['x-message-id'],
        response: response[0],
      };

    } catch (error) {
      logger.error('SendGrid error:', error);
      throw new AppError(`SendGrid error: ${error.message}`, HTTP_STATUS.BAD_GATEWAY, ERROR_CODES.EMAIL_SEND_FAILED);
    }
  }

  /**
   * Send via SMTP
   * @private
   */
  async sendViaSMTP(emailData, options = {}) {
    try {
      const mailOptions = {
        from: emailData.from,
        to: emailData.to,
        subject: emailData.subject,
        text: emailData.text,
        html: emailData.html,
        replyTo: emailData.replyTo,
        attachments: emailData.attachments,
        headers: {
          'X-Template': emailData.template || 'general',
          'X-Timestamp': new Date().toISOString(),
          ...(options.headers || {}),
        },
      };

      const result = await this.transporter.sendMail(mailOptions);
      
      return {
        messageId: result.messageId,
        response: result.response,
      };

    } catch (error) {
      logger.error('SMTP error:', error);
      throw new AppError(`SMTP error: ${error.message}`, HTTP_STATUS.BAD_GATEWAY, ERROR_CODES.EMAIL_SEND_FAILED);
    }
  }

  /**
   * Prepare email content from template
   * @private
   */
  async prepareEmailContent(templateName, templateData = {}, options = {}) {
    try {
      if (!templateName) {
        throw new AppError('Template name is required', HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR);
      }

      // Get template
      const template = await this.getTemplate(templateName);
      if (!template) {
        throw new AppError(`Template ${templateName} not found`, HTTP_STATUS.NOT_FOUND, ERROR_CODES.TEMPLATE_NOT_FOUND);
      }

      // Merge template data with defaults
      const data = {
        ...this.defaultConfig,
        currentYear: new Date().getFullYear(),
        timestamp: new Date().toISOString(),
        ...templateData,
      };

      // Render template
      const html = this.renderTemplate(template.html, data);
      const text = this.renderTemplate(template.text || this.htmlToText(template.html), data);

      return {
        html,
        text,
        template: templateName,
      };

    } catch (error) {
      logger.error(`Error preparing email content for template ${templateName}:`, error);
      throw error;
    }
  }

  /**
   * Load email templates
   * @private
   */
  async loadEmailTemplates() {
    try {
      const templatesDir = path.join(__dirname, '../../templates/email');
      
      // Default templates if directory doesn't exist
      const defaultTemplates = {
        [EMAIL_TEMPLATES.WELCOME]: {
          html: await this.getDefaultWelcomeTemplate(),
          text: 'Welcome to Tinder Clone! We\'re excited to have you on board.',
        },
        [EMAIL_TEMPLATES.NEW_MATCH]: {
          html: await this.getDefaultMatchTemplate(),
          text: 'You have a new match! {{matchName}} liked you back.',
        },
        [EMAIL_TEMPLATES.PASSWORD_RESET]: {
          html: await this.getDefaultPasswordResetTemplate(),
          text: 'Click the following link to reset your password: {{resetUrl}}',
        },
        [EMAIL_TEMPLATES.EMAIL_VERIFICATION]: {
          html: await this.getDefaultVerificationTemplate(),
          text: 'Please verify your email address: {{verificationUrl}}',
        },
      };

      try {
        // Try to load templates from files
        const files = await fs.readdir(templatesDir);
        
        for (const file of files) {
          if (file.endsWith('.html')) {
            const templateName = file.replace('.html', '');
            const htmlPath = path.join(templatesDir, file);
            const textPath = path.join(templatesDir, `${templateName}.txt`);
            
            const html = await fs.readFile(htmlPath, 'utf8');
            let text = '';
            
            try {
              text = await fs.readFile(textPath, 'utf8');
            } catch {
              text = this.htmlToText(html);
            }
            
            this.templates.set(templateName, { html, text });
          }
        }
        
        logger.info(`Loaded ${this.templates.size} email templates from files`);
        
      } catch (error) {
        // Use default templates if files don't exist
        logger.info('Email template directory not found, using default templates');
        
        for (const [name, template] of Object.entries(defaultTemplates)) {
          this.templates.set(name, template);
        }
      }

      logger.info(`Email templates loaded: ${Array.from(this.templates.keys()).join(', ')}`);

    } catch (error) {
      logger.error('Error loading email templates:', error);
      throw error;
    }
  }

  /**
   * Get template
   * @private
   */
  async getTemplate(templateName) {
    // Try cache first
    const cacheKey = `email_template:${templateName}`;
    const cachedTemplate = await CacheService.get(cacheKey);
    
    if (cachedTemplate) {
      return JSON.parse(cachedTemplate);
    }

    // Get from memory
    const template = this.templates.get(templateName);
    
    if (template) {
      // Cache for 1 hour
      await CacheService.set(cacheKey, JSON.stringify(template), 3600);
    }

    return template;
  }

  /**
   * Render template with data
   * @private
   */
  renderTemplate(template, data) {
    let rendered = template;
    
    // Simple template rendering (replace {{variable}} with data)
    for (const [key, value] of Object.entries(data)) {
      const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
      rendered = rendered.replace(regex, value || '');
    }
    
    // Remove any unreplaced variables
    rendered = rendered.replace(/{{[^}]+}}/g, '');
    
    return rendered;
  }

  /**
   * Convert HTML to plain text
   * @private
   */
  htmlToText(html) {
    return html
      .replace(/<style[^>]*>.*?<\/style>/gi, '')
      .replace(/<script[^>]*>.*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Add tracking to HTML
   * @private
   */
  addTrackingToHtml(html, email, template) {
    if (!process.env.TRACKING_DOMAIN) {
      return html;
    }

    const trackingParams = new URLSearchParams({
      email: Buffer.from(email).toString('base64'),
      template,
      timestamp: Date.now(),
    });

    const trackingPixel = `<img src="${process.env.TRACKING_DOMAIN}/email/track?${trackingParams}" width="1" height="1" style="display:none;" alt="" />`;
    
    // Add tracking pixel before closing body tag
    return html.replace('</body>', `${trackingPixel}</body>`);
  }

  /**
   * Check if user has unsubscribed
   * @private
   */
  async checkUnsubscribed(email) {
    try {
      const cacheKey = `unsubscribed:${email}`;
      const cached = await CacheService.get(cacheKey);
      
      if (cached !== null) {
        return cached === 'true';
      }

      // Check in database (implement based on your unsubscribe table)
      const isUnsubscribed = await redis.sismember('unsubscribed_emails', email);
      
      // Cache for 24 hours
      await CacheService.set(cacheKey, isUnsubscribed.toString(), 86400);
      
      return isUnsubscribed;

    } catch (error) {
      logger.error(`Error checking unsubscribe status for ${email}:`, error);
      return false; // Default to allowing emails
    }
  }

  /**
   * Validate email address
   * @private
   */
  isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * Track email metrics
   * @private
   */
  async trackEmailMetrics(email, template, success, processingTime, error = null) {
    try {
      const tags = {
        template: template || 'unknown',
        provider: this.provider,
        success: success.toString(),
      };

      if (error) {
        tags.error = error;
      }

      await Promise.all([
        MetricsService.incrementCounter('emails.sent', 1, tags),
        MetricsService.recordHistogram('emails.processing_time', processingTime, tags),
      ]);

      if (success) {
        await MetricsService.incrementCounter('emails.delivered', 1, tags);
      } else {
        await MetricsService.incrementCounter('emails.failed', 1, tags);
      }

    } catch (error) {
      logger.error('Error tracking email metrics:', error);
    }
  }

  /**
   * Process email job from queue
   * @private
   */
  async processEmailJob(jobData) {
    try {
      const { emailData, options = {} } = jobData;
      return await this.sendEmail(emailData, options);

    } catch (error) {
      logger.error('Error processing email job:', error);
      throw error;
    }
  }

  /**
   * Verify SendGrid configuration
   * @private
   */
  async verifySendGridConfig() {
    try {
      // Test with a dry run
      await this.transporter.send({
        to: 'test@example.com',
        from: this.defaultConfig.from,
        subject: 'Test',
        text: 'Test',
      }, false, { dryRun: true });

    } catch (error) {
      if (!error.message.includes('dry run')) {
        throw error;
      }
    }
  }

  /**
   * Queue email for sending
   * @param {Object} emailData - Email data
   * @param {Object} options - Queue options
   */
  async queueEmail(emailData, options = {}) {
    try {
      const { priority = 'normal', delay = 0, attempts = 3 } = options;

      await QueueService.addJob('emails', {
        emailData,
        options,
      }, {
        priority: priority === 'high' ? 10 : 0,
        delay,
        attempts,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
      });

      logger.debug(`Email queued for ${emailData.to} with template ${emailData.template}`);

    } catch (error) {
      logger.error('Error queuing email:', error);
      throw error;
    }
  }

  /**
   * Send notification email
   * @param {string} userId - User ID
   * @param {string} type - Notification type
   * @param {Object} data - Template data
   */
  async sendNotificationEmail(userId, type, data = {}) {
    try {
      // Get user email
      const User = (await import('../../modules/user/user.model.js')).default;
      const user = await User.findById(userId).select('email profile.firstName profile.displayName');
      
      if (!user || !user.email) {
        logger.debug(`No email found for user ${userId}`);
        return { success: false, reason: 'no_email' };
      }

      // Map notification type to email template
      const templateMap = {
        [NOTIFICATION_TYPES.NEW_MATCH]: EMAIL_TEMPLATES.NEW_MATCH,
        [NOTIFICATION_TYPES.PASSWORD_RESET]: EMAIL_TEMPLATES.PASSWORD_RESET,
        [NOTIFICATION_TYPES.EMAIL_VERIFICATION]: EMAIL_TEMPLATES.EMAIL_VERIFICATION,
        [NOTIFICATION_TYPES.WELCOME]: EMAIL_TEMPLATES.WELCOME,
      };

      const template = templateMap[type];
      if (!template) {
        logger.warn(`No email template found for notification type: ${type}`);
        return { success: false, reason: 'no_template' };
      }

      // Prepare template data
      const templateData = {
        userName: user.profile?.firstName || user.profile?.displayName || 'User',
        userEmail: user.email,
        ...data,
      };

      // Get subject from type
      const subjects = {
        [NOTIFICATION_TYPES.NEW_MATCH]: '🎉 You have a new match!',
        [NOTIFICATION_TYPES.PASSWORD_RESET]: 'Reset your password',
        [NOTIFICATION_TYPES.EMAIL_VERIFICATION]: 'Verify your email address',
        [NOTIFICATION_TYPES.WELCOME]: 'Welcome to Tinder Clone!',
      };

      const emailData = {
        to: user.email,
        subject: subjects[type] || 'Notification',
        template,
        templateData,
      };

      return await this.sendEmail(emailData);

    } catch (error) {
      logger.error(`Error sending notification email to user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Default template generators
   * @private
   */
  async getDefaultWelcomeTemplate() {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Welcome to {{fromName}}</title>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { text-align: center; padding: 20px 0; border-bottom: 1px solid #eee; }
        .content { padding: 30px 0; }
        .button { display: inline-block; padding: 12px 24px; background-color: #FF4458; color: white; text-decoration: none; border-radius: 25px; }
        .footer { text-align: center; padding: 20px 0; border-top: 1px solid #eee; font-size: 12px; color: #666; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <img src="{{logoUrl}}" alt="{{fromName}}" style="max-height: 50px;">
            <h1>Welcome to {{fromName}}!</h1>
        </div>
        <div class="content">
            <p>Hi {{userName}},</p>
            <p>Welcome to {{fromName}}! We're excited to have you join our community of amazing people looking to connect.</p>
            <p>Get started by completing your profile and start swiping to find your perfect match!</p>
            <p style="text-align: center;">
                <a href="{{baseUrl}}" class="button">Complete Your Profile</a>
            </p>
        </div>
        <div class="footer">
            <p>&copy; {{currentYear}} {{fromName}}. All rights reserved.</p>
        </div>
    </div>
</body>
</html>`;
  }

  async getDefaultMatchTemplate() {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>You have a new match!</title>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { text-align: center; padding: 20px 0; }
        .match-card { background: linear-gradient(45deg, #FF4458, #FF6B7D); color: white; padding: 30px; text-align: center; border-radius: 15px; margin: 20px 0; }
        .button { display: inline-block; padding: 12px 24px; background-color: #FF4458; color: white; text-decoration: none; border-radius: 25px; }
        .footer { text-align: center; padding: 20px 0; font-size: 12px; color: #666; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎉 It's a Match!</h1>
        </div>
        <div class="match-card">
            <h2>You and {{matchName}} liked each other!</h2>
            <p>Start a conversation and see where it goes.</p>
        </div>
        <p style="text-align: center;">
            <a href="{{baseUrl}}/matches" class="button">Start Chatting</a>
        </p>
        <div class="footer">
            <p>&copy; {{currentYear}} {{fromName}}. All rights reserved.</p>
        </div>
    </div>
</body>
</html>`;
  }

  async getDefaultPasswordResetTemplate() {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Reset your password</title>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .content { padding: 20px 0; }
        .button { display: inline-block; padding: 12px 24px; background-color: #FF4458; color: white; text-decoration: none; border-radius: 25px; }
        .footer { text-align: center; padding: 20px 0; font-size: 12px; color: #666; }
        .warning { background-color: #FFF3CD; border: 1px solid #FFEAA7; padding: 15px; border-radius: 5px; margin: 20px 0; }
    </style>
</head>
<body>
    <div class="container">
        <div class="content">
            <h2>Reset Your Password</h2>
            <p>Hi {{userName}},</p>
            <p>We received a request to reset your password. Click the button below to reset it:</p>
            <p style="text-align: center;">
                <a href="{{resetUrl}}" class="button">Reset Password</a>
            </p>
            <div class="warning">
                <p><strong>Security Notice:</strong> This link will expire in 1 hour. If you didn't request this reset, please ignore this email.</p>
            </div>
        </div>
        <div class="footer">
            <p>&copy; {{currentYear}} {{fromName}}. All rights reserved.</p>
        </div>
    </div>
</body>
</html>`;
  }

  async getDefaultVerificationTemplate() {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Verify your email address</title>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .content { padding: 20px 0; }
        .button { display: inline-block; padding: 12px 24px; background-color: #FF4458; color: white; text-decoration: none; border-radius: 25px; }
        .footer { text-align: center; padding: 20px 0; font-size: 12px; color: #666; }
    </style>
</head>
<body>
    <div class="container">
        <div class="content">
            <h2>Verify Your Email Address</h2>
            <p>Hi {{userName}},</p>
            <p>Please verify your email address to complete your {{fromName}} registration:</p>
            <p style="text-align: center;">
                <a href="{{verificationUrl}}" class="button">Verify Email</a>
            </p>
            <p>If the button doesn't work, copy and paste this link into your browser:</p>
            <p style="word-break: break-all; color: #666;">{{verificationUrl}}</p>
        </div>
        <div class="footer">
            <p>&copy; {{currentYear}} {{fromName}}. All rights reserved.</p>
        </div>
    </div>
</body>
</html>`;
  }

  /**
   * Get email statistics
   */
  async getEmailStats(dateRange = {}) {
    try {
      const { start, end } = dateRange;
      const timeFilter = {};
      
      if (start || end) {
        timeFilter.timestamp = {};
        if (start) timeFilter.timestamp.$gte = start;
        if (end) timeFilter.timestamp.$lte = end;
      }

      const stats = await MetricsService.getMetricStats('emails.sent', timeFilter);
      
      return {
        totalSent: stats.total || 0,
        deliveryRate: stats.deliveryRate || 0,
        averageProcessingTime: stats.averageProcessingTime || 0,
        byTemplate: stats.byTemplate || {},
        byProvider: stats.byProvider || {},
      };

    } catch (error) {
      logger.error('Error getting email stats:', error);
      return {
        totalSent: 0,
        deliveryRate: 0,
        averageProcessingTime: 0,
        byTemplate: {},
        byProvider: {},
      };
    }
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      if (!this.initialized) {
        return { status: 'unhealthy', error: 'Service not initialized' };
      }

      if (this.provider === 'smtp') {
        await this.transporter.verify();
      }

      return { 
        status: 'healthy', 
        provider: this.provider,
        templatesLoaded: this.templates.size 
      };

    } catch (error) {
      return { status: 'unhealthy', error: error.message };
    }
  }
}

export default new EmailService();