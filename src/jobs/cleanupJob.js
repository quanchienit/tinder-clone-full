export async function cleanupExpiredData() {
  try {
    const now = new Date();
    
    // Remove expired boosts
    await Boost.deleteMany({
      expiresAt: { $lt: now }
    });

    // Remove old unmatched swipes (older than 30 days)
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
    await Swipe.deleteMany({
      createdAt: { $lt: thirtyDaysAgo },
      action: 'nope'
    });

    // Clean up old notifications
    await Notification.deleteMany({
      createdAt: { $lt: thirtyDaysAgo },
      read: true
    });

    // Remove inactive user sessions
    const inactiveDate = new Date(now - 90 * 24 * 60 * 60 * 1000);
    await User.updateMany(
      { 'status.lastActive': { $lt: inactiveDate } },
      { $set: { 'status.isActive': false } }
    );

    logger.info('Cleanup job completed');
  } catch (error) {
    logger.error('Error in cleanup job:', error);
  }
}